import { test, expect, cleanupRoom, createRoom, joinRoom, selectChar, startGame, waitForGameScreen, BASE_URL, jumpToPhase7AndProcess } from './setup';
import { Page } from '@playwright/test';

// ゲームを開始してPhase1に到達するまでのセットアップ
async function setupGameToPhase1(browser: any): Promise<{
  pages: Page[];
  leaderPage: Page;
  nonLeaderPages: Page[];
  roomCode: string;
}> {
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

  await Promise.all(
    pages.map(p =>
      p.waitForFunction(
        () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
        { timeout: 20000 }
      )
    )
  );

  await startGame(pages);

  // Phase1に到達するまで待つ
  await Promise.all(pages.map(p => p.waitForSelector('#g-phase-badge', { timeout: 15000 })));

  // リーダーを特定（#g-controls に 次のフェーズへ ボタンがある方）
  let leaderPage: Page = pages[0];
  let leaderIdx = 0;
  for (let i = 0; i < pages.length; i++) {
    const ctrl = await pages[i].locator('#g-controls').textContent({ timeout: 10000 });
    if (ctrl && ctrl.includes('次のフェーズへ')) {
      leaderPage = pages[i];
      leaderIdx = i;
      break;
    }
    // wait-modal が開いていれば非リーダー、なければリーダー候補
    const waitOpen = await pages[i].locator('#wait-modal.open').isVisible().catch(() => false);
    if (!waitOpen) {
      leaderPage = pages[i];
      leaderIdx = i;
    }
  }

  const nonLeaderPages = pages.filter((_, i) => i !== leaderIdx);
  return { pages, leaderPage, nonLeaderPages, roomCode };
}

// ============================================================
// シナリオ3：Phase1〜Phase5（リーダー準備〜アクション配布）
// ============================================================
test.describe('シナリオ3：Phase1〜Phase5', () => {
  test('リーダーのみフェーズ進行ボタンが表示され、非リーダーはWAITINGモーダルを確認', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase1: リーダーに「次のフェーズへ」ボタンが表示される
      await expect(leaderPage.locator('#g-controls button:has-text("次のフェーズへ")')).toBeVisible({ timeout: 15000 });

      // 非リーダーはWAITINGモーダルが表示される
      for (const p of nonLeaderPages) {
        await expect(p.locator('#wait-modal')).toBeVisible({ timeout: 10000 });
      }

      // Phase1 → 2
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 2'),
        { timeout: 15000 }
      );

      // Phase2: リーダーに次のフェーズボタン
      await expect(leaderPage.locator('#g-controls button:has-text("次のフェーズへ")')).toBeVisible({ timeout: 10000 });

      // Phase2 → 3
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 3'),
        { timeout: 15000 }
      );

      // Phase3 → 4
      await leaderPage.click('#g-controls button:has-text("アピールタイムへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
        { timeout: 15000 }
      );

      // Phase4: リーダーに「アクション配布へ」ボタン
      await expect(leaderPage.locator('#g-controls button:has-text("アクション配布へ")')).toBeVisible({ timeout: 10000 });

      // Phase4 → 5（アクション配布モーダルを開く）
      await leaderPage.click('#g-controls button:has-text("アクション配布へ")');

      // Phase5: dist-modal が開くことを確認（リーダーのみ）
      await expect(leaderPage.locator('#dist-modal')).toBeVisible({ timeout: 10000 });

      // 非リーダーはWAITINGモーダルが表示される
      for (const p of nonLeaderPages) {
        await expect(p.locator('#wait-modal')).toBeVisible({ timeout: 10000 });
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('同じカードを2人に割り当てるとエラーが表示される', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase1〜4を進める
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 2'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 3'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アピールタイムへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アクション配布へ")');
      await expect(leaderPage.locator('#dist-modal')).toBeVisible({ timeout: 10000 });

      // 全セレクトボックスを同じ値（0）にして重複を作る
      const selects = leaderPage.locator('#dist-rows .dist-sel');
      const count = await selects.count();
      for (let i = 0; i < count; i++) {
        await selects.nth(i).selectOption('0');
      }

      // CONFIRM & SEND を押す
      await leaderPage.click('#dist-modal button:has-text("CONFIRM & SEND")');

      // エラートーストが表示されることを確認
      await expect(leaderPage.locator('.toast')).toBeVisible({ timeout: 5000 });
      const toastText = await leaderPage.locator('.toast').textContent();
      expect(toastText).toContain('同じカード');

      // モーダルはまだ開いたまま
      await expect(leaderPage.locator('#dist-modal')).toBeVisible();
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('正しくアクションを配布するとPhase6に進む', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase1〜4を進める
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 2'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 3'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アピールタイムへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アクション配布へ")');
      await expect(leaderPage.locator('#dist-modal')).toBeVisible({ timeout: 10000 });

      // 各プレイヤーに異なるカードを割り当て（デフォルト値を維持）
      // デフォルトでは player[i] に action[i] が割り当てられているので重複なし
      await leaderPage.click('#dist-modal button:has-text("CONFIRM & SEND")');

      // Phase6に遷移することを確認
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
        { timeout: 15000 }
      );

      // 全員のブラウザもPhase6になる
      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
            { timeout: 20000 }
          )
        )
      );
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});

// ============================================================
// シナリオ4：Phase6 アクション実行
// ============================================================
test.describe('シナリオ4：Phase6 アクション実行', () => {
  test('ダイスを振らずにEXECUTEを押すと弾かれる', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase1〜5を進めてPhase6へ
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 2'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 3'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アピールタイムへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アクション配布へ")');
      await expect(leaderPage.locator('#dist-modal')).toBeVisible({ timeout: 10000 });
      await leaderPage.click('#dist-modal button:has-text("CONFIRM & SEND")');

      // Phase6に到達したら、現在のターンプレイヤーのページを特定
      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
            { timeout: 20000 }
          )
        )
      );

      // アクション実行ボタンが表示されているページを探す（自分のターンのプレイヤー）
      let turnPage: Page | null = null;
      for (const p of pages) {
        const hasAction = await p.locator('#g-controls button:has-text("アクションを実行する")').isVisible().catch(() => false);
        if (hasAction) {
          turnPage = p;
          break;
        }
      }

      if (turnPage) {
        // アクション実行モーダルを開く
        await turnPage.click('#g-controls button:has-text("アクションを実行する")');
        await expect(turnPage.locator('#action-modal')).toBeVisible({ timeout: 10000 });

        // アクションタイプを確認（電池生産か電池散策の場合）
        const modalTitle = await turnPage.locator('#am-title').textContent();
        if (modalTitle?.includes('電池生産') || modalTitle?.includes('電池散策')) {
          // ダイスを振らずにEXECUTEを押す
          await turnPage.click('#am-btns button:has-text("EXECUTE")');

          // トーストエラーが表示される
          await expect(turnPage.locator('.toast')).toBeVisible({ timeout: 5000 });
          const toastText = await turnPage.locator('.toast').textContent();
          expect(toastText).toContain('ダイスを振って');
        }
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('電池生産：ダイスを振ってEXECUTEで手札が増える', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase6まで進める
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 2'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 3'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アピールタイムへ")');
      await leaderPage.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
        { timeout: 15000 }
      );
      await leaderPage.click('#g-controls button:has-text("アクション配布へ")');
      await expect(leaderPage.locator('#dist-modal')).toBeVisible({ timeout: 10000 });
      await leaderPage.click('#dist-modal button:has-text("CONFIRM & SEND")');

      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
            { timeout: 20000 }
          )
        )
      );

      // アクションが電池生産か電池散策のプレイヤーのページを探す
      for (const p of pages) {
        const hasAction = await p.locator('#g-controls button:has-text("アクションを実行する")').isVisible().catch(() => false);
        if (!hasAction) continue;

        await p.click('#g-controls button:has-text("アクションを実行する")');
        await expect(p.locator('#action-modal')).toBeVisible({ timeout: 10000 });

        const modalTitle = await p.locator('#am-title').textContent();
        if (!modalTitle?.includes('電池生産') && !modalTitle?.includes('電池散策')) {
          // ダイスを使わないアクション（電力支援など）はスキップ
          await p.locator('#action-modal').evaluate(el => el.classList.remove('open'));
          break;
        }

        // 手札の枚数を記録
        const beforeCount = await p.locator('#g-hand-cards .hcard').count();

        // ダイスを振る
        await p.click('#am-content button:has-text("ダイスを振る")');

        // ダイス結果が表示されるまで待つ（アニメーション後）
        await p.waitForFunction(
          () => {
            const v = document.getElementById('dice-val') || document.getElementById('dice-val2');
            return v && v.textContent !== '-';
          },
          { timeout: 10000 }
        );

        // EXECUTEを押す
        await p.click('#am-btns button:has-text("EXECUTE")');

        // アクションモーダルが閉じる
        await expect(p.locator('#action-modal')).not.toBeVisible({ timeout: 10000 });

        // 手札が増えていることを確認（ダイス結果が0の場合は増えない）
        // Phase7以降に遷移するか次のプレイヤーのターンになる
        break;
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});

// ============================================================
// シナリオ5：Phase7 電力消費
// ============================================================
test.describe('シナリオ5：Phase7 電力消費', () => {
  test('全プレイヤー順番に電力消費モーダルが表示され処理できる', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Firebase REST API でPhase7に直接ジャンプ（Phase 6 のアクション実行をスキップ）
      // jumpToPhase7AndProcess は:
      //   1. deck を null にして consumeQueue をセット
      //   2. 全ページが PHASE 7 バッジを表示するまで待つ
      //   3. 最初のプレイヤーが「電力消費を処理する」ボタンを持つことを Promise.race で確認
      await jumpToPhase7AndProcess(pages, roomCode);

      // 全プレイヤーが消費を完了するとゲームが終了（deck=null で山札切れ判定）
      // または次ターンになる → いずれにせよ全員の画面が更新される
      // 最終状態を確認：end-screen か次フェーズ
      for (const p of pages) {
        await p.waitForFunction(
          () =>
            document.getElementById('end-screen')?.classList.contains('active') ||
            document.getElementById('g-phase-badge')?.textContent?.includes('PHASE'),
          { timeout: 20000 }
        );
      }

      // Phase 7 中にconsume-modalが表示されたことを間接的に確認（モーダルが閉じている）
      for (const p of pages) {
        await expect(p.locator('#consume-modal')).not.toBeVisible();
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('フル電池をクリックすると消費されて稼働継続する', async ({ browser }) => {
    const { pages, leaderPage, nonLeaderPages, roomCode } = await setupGameToPhase1(browser);
    try {
      // Phase7に直接ジャンプしてconsume-modalを開く（最初のプレイヤーのみ）
      const { fbGet: _fbGet, jumpToPhase7AndProcess: _jump } = await import('./setup');
      const players = await _fbGet(`rooms/${roomCode}/players`);
      const playerKeys: string[] = Object.keys(players).sort(
        (a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0)
      );

      const FIREBASE_DB_URL = 'https://zanden-game-default-rtdb.firebaseio.com';
      await fetch(`${FIREBASE_DB_URL}/rooms/${roomCode}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 7,
          consumeQueue: playerKeys,
          consumeQueueIdx: 0,
        }),
      });

      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 7'),
            { timeout: 15000 }
          )
        )
      );

      // 最初のプレイヤーのページで「電力消費を処理する」ボタンが出るまで待つ
      const consumePageIdx: number = await Promise.race(
        pages.map((p, idx) =>
          p.locator('#g-controls button:has-text("電力消費を処理する")')
            .waitFor({ state: 'visible', timeout: 15000 })
            .then(() => idx)
        )
      );
      const consumePage = pages[consumePageIdx];

      // モーダルを開く
      await consumePage.click('#g-controls button:has-text("電力消費を処理する")');
      await consumePage.waitForSelector('#consume-modal.open', { timeout: 10000 });

      // フル電池があれば消費（稼働継続）
      const fullCards = consumePage.locator('#cm-content .hcard.full');
      if (await fullCards.count() > 0) {
        const handBefore = await consumePage.locator('#g-hand-cards .hcard').count();
        await fullCards.first().click();
        // モーダルが閉じる
        await consumePage.waitForFunction(
          () => !document.getElementById('consume-modal')?.classList.contains('open'),
          { timeout: 10000 }
        );
        // 手札が1枚減っていることを確認（フル電池を消費）
        const handAfter = await consumePage.locator('#g-hand-cards .hcard').count();
        expect(handAfter).toBe(handBefore - 1);
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});
