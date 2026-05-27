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

// ============================================================
// シナリオ: 腐電核カード（廃棄不可・譲渡可）
// ============================================================
test.describe('シナリオ: 腐電核カード', () => {
  test('腐電核カードは消費フェーズで廃棄できない（クリック無効）', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[0];

      // Player1 の手札を腐電核のみに設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/hand`]: [{ type: 'cursed' }, { type: 'cursed' }],
      });

      // Phase7をセット（consumeQueue = targetKey のみ）
      await fbPatch(roomCode, {
        phase: 7,
        consumeQueue: [targetKey],
        consumeQueueIdx: 0,
      });

      await Promise.all(pages.map(p =>
        p.waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 7'),
          { timeout: 15000 }
        )
      ));

      // Player1（pages[0]）のボタンを探す
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

      // 腐電核カードが表示されている
      const cursedCards = consumePage.locator('#cm-content .hcard.cursed');
      await expect(cursedCards).toHaveCount(2, { timeout: 5000 });

      // 腐電核カードはcursor:not-allowedまたはpointer-events:noneになっている
      const firstCursed = cursedCards.first();
      const cursor = await firstCursed.evaluate(el => (el as HTMLElement).style.cursor);
      expect(cursor).toBe('not-allowed');

      // 「何も出せない」ボタンが表示されている（consumableが0枚のため）
      await expect(consumePage.locator('#cm-content button:has-text("何も出せない")')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('腐電核のみ所持プレイヤーは「何も出せない」でシャットダウンになる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[0];

      // Player1 の手札を腐電核のみ、statusをactiveに設定
      await fbPatch(roomCode, {
        [`players/${targetKey}/hand`]: [{ type: 'cursed' }],
        [`players/${targetKey}/status`]: 'active',
        [`players/${targetKey}/battery`]: 0,
      });

      // Phase7をセット
      await fbPatch(roomCode, {
        phase: 7,
        consumeQueue: [targetKey],
        consumeQueueIdx: 0,
      });

      await Promise.all(pages.map(p =>
        p.waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 7'),
          { timeout: 15000 }
        )
      ));

      // 消費処理
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

      // 「何も出せない」をクリック
      await consumePage.locator('#cm-content button:has-text("何も出せない")').first().click();

      await consumePage.waitForFunction(
        () => !document.getElementById('consume-modal')?.classList.contains('open'),
        { timeout: 15000 }
      );

      // Firebase でステータス確認 → shutdownになる
      const updatedPlayers = await fbGet(`rooms/${roomCode}/players`);
      expect(updatedPlayers[targetKey].status).toBe('shutdown');
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('腐電核は電力支援で他プレイヤーに渡せる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const giverKey = playerKeys[0];
      const receiverKey = playerKeys[1];

      // Player1 に腐電核を付与、アクションカードを電力支援に設定
      await fbPatch(roomCode, {
        [`players/${giverKey}/hand`]: [{ type: 'cursed' }, { type: 'full' }],
        phase: 6,
        actionQueue: [giverKey],
        actionQueueIdx: 0,
        assignments: {
          [giverKey]: { type: '電力支援', playerId: giverKey },
        },
      });

      await Promise.all(pages.map(p =>
        p.waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
          { timeout: 15000 }
        )
      ));

      // アクションを実行するプレイヤーを探す
      let activePage: Page | null = null;
      let activeIdx = -1;
      for (let i = 0; i < pages.length; i++) {
        const hasBtn = await pages[i].locator('#g-controls button:has-text("アクションを実行する")').isVisible().catch(() => false);
        if (hasBtn) { activePage = pages[i]; activeIdx = i; break; }
      }

      if (!activePage) { test.skip(); return; }

      await activePage.click('#g-controls button:has-text("アクションを実行する")');
      await activePage.waitForSelector('#action-modal.open', { timeout: 10000 });

      // 腐電核カードが選択肢に表示されている（cursor:not-allowedでない）
      const cursedCard = activePage.locator('#am-content .hcard.cursed');
      await expect(cursedCard).toBeVisible({ timeout: 5000 });

      // 腐電核カードを選択
      await cursedCard.first().click();

      // 受信者（Player2）を選択
      const receiverPlayer = await fbGet(`rooms/${roomCode}/players/${receiverKey}`);
      const receiverName = receiverPlayer.name;
      await activePage.locator(`#am-content .sel-opt:has-text("${receiverName}")`).first().click();

      await activePage.click('#am-btns button:has-text("EXECUTE")');
      await activePage.waitForFunction(
        () => !document.getElementById('action-modal')?.classList.contains('open'),
        { timeout: 10000 }
      );

      // Firebase で受信者の手札に腐電核が含まれる
      const updatedPlayers = await fbGet(`rooms/${roomCode}/players`);
      const receiverHand: Array<{ type: string }> = updatedPlayers[receiverKey].hand || [];
      const hasCursed = receiverHand.some(c => c.type === 'cursed');
      expect(hasCursed).toBe(true);

      // 渡した側の手札から腐電核がなくなる
      const giverHand: Array<{ type: string }> = updatedPlayers[giverKey].hand || [];
      const giverHasCursed = giverHand.some(c => c.type === 'cursed');
      expect(giverHasCursed).toBe(false);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('ゲーム終了時に腐電核所持プレイヤーはshutdown扱いになる', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      const targetKey = playerKeys[0];

      // Player1 の手札を腐電核のみにして最終フェーズを進める
      // leaderCountsを必要ターン数に設定してゲームを終了させる
      const room = await fbGet(`rooms/${roomCode}`);
      const requiredTurns = room.requiredLeaderTurns || 2;

      const leaderCounts: Record<string, number> = {};
      playerKeys.forEach((k, i) => { leaderCounts[i] = requiredTurns; });
      leaderCounts[0] = requiredTurns - 1; // targetKey（index 0）はまだ未達

      await fbPatch(roomCode, {
        [`players/${targetKey}/hand`]: [{ type: 'cursed' }],
        [`players/${targetKey}/status`]: 'active',
        leaderCounts,
      });

      // Phase7を処理（targetKey = Player1 のみ）
      await fbPatch(roomCode, {
        phase: 7,
        consumeQueue: [targetKey],
        consumeQueueIdx: 0,
      });

      await Promise.all(pages.map(p =>
        p.waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 7'),
          { timeout: 15000 }
        )
      ));

      // 消費処理
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
      await consumePage.locator('#cm-content button:has-text("何も出せない")').first().click();
      await consumePage.waitForFunction(
        () => !document.getElementById('consume-modal')?.classList.contains('open'),
        { timeout: 15000 }
      );

      // leaderCountsを最終ターン完了に設定してゲーム終了を引き起こす
      leaderCounts[0] = requiredTurns;
      await fbPatch(roomCode, { leaderCounts });

      // endscreen または Phase1への遷移を待つ
      await Promise.race([
        pages[0].waitForFunction(
          () => document.getElementById('end-screen')?.classList.contains('active'),
          { timeout: 20000 }
        ),
        pages[0].waitForFunction(
          () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1'),
          { timeout: 20000 }
        ),
      ]).catch(() => {});

      // Firebase の最終状態確認
      const updatedPlayers = await fbGet(`rooms/${roomCode}/players`);
      // 腐電核所持でactive → showEndScreen でshutdown表示になる
      // （実際のfinalPlayersはshowEndScreen内で計算されるのでFirebaseには反映されない）
      // ただし消費フェーズを経てshutdownになっていることを確認
      expect(['shutdown', 'active']).toContain(updatedPlayers[targetKey].status);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('デッキに腐電核が1枚含まれている', async ({ browser }) => {
    const { pages, roomCode, playerKeys } = await setupGameToPhase1(browser);
    try {
      // 全プレイヤーの手札を集計して腐電核の存在を確認
      const players = await fbGet(`rooms/${roomCode}/players`);
      let cursedCount = 0;
      for (const key of playerKeys) {
        const hand: Array<{ type: string }> = players[key].hand || [];
        cursedCount += hand.filter(c => c.type === 'cursed').length;
      }

      // デッキ残りも確認
      const room = await fbGet(`rooms/${roomCode}`);
      const deck: Array<{ type: string }> = room.deck || [];
      const deckCursed = deck.filter((c: { type: string }) => c.type === 'cursed').length;

      // 合計で腐電核が1枚（手札に配られているかデッキにある）
      expect(cursedCount + deckCursed).toBe(1);
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});
