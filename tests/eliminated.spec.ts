import { test, expect, cleanupRoom, createRoom, joinRoom, startGame, BASE_URL, fbGet } from './setup';
import { Page } from '@playwright/test';

const FIREBASE_DB_URL = 'https://zanden-game-default-rtdb.firebaseio.com';

async function fbPatch(roomCode: string, data: Record<string, unknown>) {
  await fetch(`${FIREBASE_DB_URL}/rooms/${roomCode}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function setupGameToPhase1(browser: any): Promise<{ pages: Page[]; roomCode: string; playerKeys: string[] }> {
  const contexts = [];
  const pages: Page[] = [];
  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    contexts.push(ctx);
    pages.push(page);
  }

  const roomCode = await createRoom(pages[0], 'Player1', 4);
  await joinRoom(pages[1], roomCode, 'Player2');
  await joinRoom(pages[2], roomCode, 'Player3');
  await joinRoom(pages[3], roomCode, 'Player4');

  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
      { timeout: 20000 }
    )
  ));

  await startGame(pages);

  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1'),
      { timeout: 15000 }
    )
  ));

  const players = await fbGet(`rooms/${roomCode}/players`);
  const playerKeys: string[] = Object.keys(players).sort(
    (a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0)
  );

  return { pages, roomCode, playerKeys };
}

// Phase7消費フェーズを処理する（デッキに手を加えない）
async function processConsumePhase(pages: Page[], roomCode: string, consumeQueue: string[]) {
  await fbPatch(roomCode, {
    phase: 7,
    consumeQueue,
    consumeQueueIdx: 0,
  });

  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 7'),
      { timeout: 15000 }
    )
  ));

  for (let i = 0; i < consumeQueue.length; i++) {
    const ended = await pages[0].locator('#end-screen.active').isVisible().catch(() => false);
    if (ended) break;

    const consumePageIdx: number = await Promise.race(
      pages.map((p, idx) =>
        p.locator('#g-controls button:has-text("電力消費を処理する")')
          .waitFor({ state: 'visible', timeout: 20000 })
          .then(() => idx)
      )
    );
    const consumePage = pages[consumePageIdx];

    await consumePage.click('#g-controls button:has-text("電力消費を処理する")');
    await consumePage.waitForSelector('#consume-modal.open', { timeout: 10000 });

    const isShutdown = await consumePage
      .locator('#cm-content button:has-text("再起動しない（スキップ）")')
      .isVisible().catch(() => false);

    if (isShutdown) {
      await consumePage.locator('#cm-content button:has-text("再起動しない（スキップ）")').first().click();
    } else {
      const fullCards = consumePage.locator('#cm-content .hcard.full');
      const emptyCards = consumePage.locator('#cm-content .hcard.empty, #cm-content .hcard.virus');
      const skipBtn = consumePage.locator('#cm-content button:has-text("何も出せない")');

      if (await fullCards.count() > 0) {
        await fullCards.first().click();
      } else if (await emptyCards.count() > 0) {
        await emptyCards.first().click();
      } else if (await skipBtn.count() > 0) {
        await skipBtn.first().click();
      }
    }

    await consumePage.waitForFunction(
      () => !document.getElementById('consume-modal')?.classList.contains('open'),
      { timeout: 15000 }
    );
  }
}

// ============================================================
// シナリオ: 脱落システム（4人ゲーム・閾値2ターン）
// ============================================================
test.describe('シナリオ: 脱落システム', () => {
  test('4人ゲームで2ターン停止したプレイヤーがeliminatedになる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[3]; // Player4 を脱落候補に

      // Player4 を shutdown（shutdownTurns=1）に設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/status`]: 'shutdown',
        [`players/${targetKey}/shutdownTurns`]: 1,
      });

      // Phase7を処理（全4プレイヤー）→ checkEndCondition が shutdownTurns を 2 に → eliminated
      await processConsumePhase(pages, roomCode, playerKeys);

      // Phase1 or end-screen に遷移するまで待つ
      await Promise.all(
        pages.filter((_, i) => i !== 3).map(p =>
          p.waitForFunction(
            () =>
              document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1') ||
              document.getElementById('end-screen')?.classList.contains('active'),
            { timeout: 20000 }
          )
        )
      );

      // Firebase でステータス確認
      const updatedPlayers = await fbGet(`rooms/${roomCode}/players`);
      expect(updatedPlayers[targetKey].status).toBe('eliminated');
      expect(updatedPlayers[targetKey].shutdownTurns).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('脱落プレイヤーのページはELIMINATED表示・手札非表示になる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[3]; // Player4

      // Player4 を直接 eliminated に設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/status`]: 'eliminated',
        [`players/${targetKey}/shutdownTurns`]: 2,
      });

      // 全ブラウザが Firebase 更新を受信するまで待つ
      // Player4 のページ（pages[3]）が ELIMINATED 表示になる
      // pages[3] = Player4 のブラウザ（joinedAt 順と pages 順が対応）
      await pages[3].waitForFunction(
        () => document.getElementById('g-phase-box')?.textContent?.includes('ELIMINATED'),
        { timeout: 15000 }
      );

      // フェーズボックスに観戦メッセージが含まれる
      const phaseText = await pages[3].locator('#g-phase-box').textContent();
      expect(phaseText).toContain('ELIMINATED');
      expect(phaseText).toContain('観戦');

      // 手札エリアが非表示
      await expect(pages[3].locator('#g-hand-area')).not.toBeVisible();

      // アクションエリアが非表示
      await expect(pages[3].locator('#g-action-area')).not.toBeVisible();

      // 他プレイヤーのプレイヤーカードに ELIMINATED が表示される
      const playerCardText = await pages[0].locator('#g-players-grid').textContent({ timeout: 5000 });
      expect(playerCardText).toContain('ELIMINATED');
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('消費キューに脱落プレイヤーは含まれない', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[3]; // Player4 を脱落させる

      // Player4 を eliminated に設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/status`]: 'eliminated',
        [`players/${targetKey}/shutdownTurns`]: 2,
      });

      // Phase7を処理（eliminated を除く3人のみのキュー）
      const activeQueue = playerKeys.filter(k => k !== targetKey);
      await processConsumePhase(pages, roomCode, activeQueue);

      // Phase1 or end-screen に遷移するまで待つ（非脱落プレイヤー）
      await Promise.all(
        pages.slice(0, 3).map(p =>
          p.waitForFunction(
            () =>
              document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1') ||
              document.getElementById('end-screen')?.classList.contains('active'),
            { timeout: 20000 }
          )
        )
      );

      // Firebase の consumeQueue に eliminated プレイヤーが含まれていないことを確認
      const room = await fbGet(`rooms/${roomCode}`);
      const cq: string[] = room.consumeQueue || [];
      expect(cq).not.toContain(targetKey);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('脱落後にアクションカード引き枚数が非脱落人数になる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[3]; // Player4

      // Player4 を eliminated に設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/status`]: 'eliminated',
      });

      // リーダーを特定してPhase2（アクション引き）へ進める
      let leaderPage: Page = pages[0];
      for (const p of pages) {
        const hasBtn = await p.locator('#g-controls button:has-text("次のフェーズへ")').isVisible().catch(() => false);
        if (hasBtn) { leaderPage = p; break; }
      }

      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');

      // Phase4まで遷移を待つ
      await Promise.all(pages.map(p =>
        p.waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
          { timeout: 15000 }
        )
      ));

      // drawnActions の枚数を Firebase で確認（4人ゲームで1人脱落 → 3枚）
      const room = await fbGet(`rooms/${roomCode}`);
      const drawn: unknown[] = room.drawnActions || [];
      expect(drawn.length).toBe(3);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});
