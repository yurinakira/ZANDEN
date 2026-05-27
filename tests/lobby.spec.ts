import { test, expect, cleanupRoom, createRoom, joinRoom, selectChar, startGame, waitForGameScreen, BASE_URL } from './setup';

// ============================================================
// シナリオ1：ルーム作成と参加
// ============================================================
test.describe('シナリオ1：ルーム作成と参加', () => {
  let roomCode = '';

  test.afterEach(async () => {
    if (roomCode) await cleanupRoom(roomCode);
  });

  test('ホストがルームを作成し、3人が参加してロビーに全員表示される', async ({ browser }) => {
    const contexts = [];
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE_URL);
      contexts.push(ctx);
      pages.push(page);
    }

    try {
      // Player1 がルームを作成（4人設定）
      roomCode = await createRoom(pages[0], 'Player1', 4);
      expect(roomCode).toHaveLength(6);

      // Player2〜4 が同じコードで参加
      await joinRoom(pages[1], roomCode, 'Player2');
      await joinRoom(pages[2], roomCode, 'Player3');
      await joinRoom(pages[3], roomCode, 'Player4');

      // 全員のロビーに4人の名前が表示されるまで待つ
      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
            { timeout: 20000 }
          )
        )
      );

      // 各プレイヤーのロビーに全員の名前が表示されていることを確認
      for (const page of pages) {
        const playerItems = page.locator('#lobby-player-list .player-list-item');
        await expect(playerItems).toHaveCount(4);

        const listText = await page.locator('#lobby-player-list').textContent();
        expect(listText).toContain('Player1');
        expect(listText).toContain('Player2');
        expect(listText).toContain('Player3');
        expect(listText).toContain('Player4');
      }

      // ルームコードが全員に表示されていることを確認
      for (const page of pages) {
        const displayedCode = await page.locator('#lobby-room-code').textContent();
        expect(displayedCode?.trim()).toBe(roomCode);
      }
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });
});

// ============================================================
// シナリオ2：ゲーム開始
// ============================================================
test.describe('シナリオ2：ゲーム開始', () => {
  let roomCode = '';

  test.afterEach(async () => {
    if (roomCode) await cleanupRoom(roomCode);
  });

  test('全員キャラクター選択後にホストがゲームを開始し全員ゲーム画面へ遷移する', async ({ browser }) => {
    const contexts = [];
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE_URL);
      contexts.push(ctx);
      pages.push(page);
    }

    try {
      // ルーム作成・参加
      roomCode = await createRoom(pages[0], 'Player1', 4);
      await joinRoom(pages[1], roomCode, 'Player2');
      await joinRoom(pages[2], roomCode, 'Player3');
      await joinRoom(pages[3], roomCode, 'Player4');

      // 全員揃うのを待つ
      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
            { timeout: 20000 }
          )
        )
      );

      // 全員がキャラクターを選択（それぞれ別のキャラクター）
      for (let i = 0; i < 4; i++) {
        await selectChar(pages[i], i);
        await pages[i].waitForTimeout(600);
      }

      // START GAMEボタンが有効になるのを待つ（ホストのみ表示）
      const startBtn = pages[0].locator('#start-btn');
      await expect(startBtn).toBeEnabled({ timeout: 15000 });
      await startBtn.click();

      // 全員がゲーム画面に遷移することを確認
      await waitForGameScreen(pages);

      // 全員の手札が2枚であることを確認
      for (const page of pages) {
        const handCards = page.locator('#g-hand-cards .hcard');
        await expect(handCards).toHaveCount(2, { timeout: 15000 });
      }

      // デッキ残数が35枚（43 - 4×2）であることを確認（腐電核追加でデッキ43枚）
      const deckCount = await pages[0].waitForSelector('#g-deck');
      const deckText = await deckCount.textContent();
      expect(parseInt(deckText ?? '0')).toBe(35);
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });
});
