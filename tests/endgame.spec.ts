import { test, expect, cleanupRoom, createRoom, joinRoom, selectChar, startGame, waitForGameScreen, BASE_URL, fbGet, jumpToPhase7AndProcess } from './setup';
import { Page } from '@playwright/test';

const FIREBASE_DB_URL = 'https://zanden-game-default-rtdb.firebaseio.com';

// Firebase REST API で値をセット（PUT = 上書き）
async function fbPut(path: string, value: unknown) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

// 4ブラウザを立ち上げてゲームをPhase1まで進める共通処理
async function setupGameToPhase1(browser: any): Promise<{ pages: Page[]; roomCode: string }> {
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
  await Promise.all(
    pages.map(p =>
      p.waitForFunction(
        () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1'),
        { timeout: 15000 }
      )
    )
  );

  return { pages, roomCode };
}

// ============================================================
// シナリオ7：ゲーム終了（山札切れ）
// ============================================================
test.describe('シナリオ7：ゲーム終了（山札切れ）', () => {
  test('デッキを空にしてPhase7を完了するとリザルト画面が全員に表示される', async ({ browser }) => {
    const { pages, roomCode } = await setupGameToPhase1(browser);
    try {
      // デッキを空にして Phase7 へ飛び、全消費処理を行う
      await jumpToPhase7AndProcess(pages, roomCode);

      // 全員のブラウザでリザルト画面が表示されることを確認
      await Promise.all(
        pages.map(p => p.waitForSelector('#end-screen.active', { timeout: 20000 }))
      );

      // リザルト画面のコンテンツを確認
      for (const p of pages) {
        const endContent = await p.locator('#end-content').textContent({ timeout: 10000 });
        // 稼働状態の勝者（WINNER）または全員停止（ALL SHUTDOWN）が表示される
        expect(endContent?.includes('WINNER') || endContent?.includes('ALL SHUTDOWN')).toBe(true);
      }

      // 稼働中プレイヤーが勝者の場合、MVPも表示される
      const endText = await pages[0].locator('#end-content').textContent();
      if (endText?.includes('WINNER')) {
        expect(endText).toContain('MVP');
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('WAITINGモーダルでゲーム終了が発火してもリザルト画面に遷移する', async ({ browser }) => {
    const { pages, roomCode } = await setupGameToPhase1(browser);
    try {
      // ゲーム開始直後にFirebaseのステータスをendedにする
      await fbPut(`rooms/${roomCode}/status`, 'ended');

      // 全員がリザルト画面に遷移することを確認（WAITINGで止まらない）
      await Promise.all(
        pages.map(p => p.waitForSelector('#end-screen.active', { timeout: 20000 }))
      );

      // WAITINGモーダルが閉じていることを確認
      for (const p of pages) {
        await expect(p.locator('#wait-modal')).not.toBeVisible();
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('稼働状態プレイヤーが勝者、フル電池最多がMVPとして表示される', async ({ browser }) => {
    const { pages, roomCode } = await setupGameToPhase1(browser);
    try {
      // プレイヤーキーを取得
      const players = await fbGet(`rooms/${roomCode}/players`);
      const playerKeys: string[] = Object.keys(players).sort(
        (a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0)
      );

      // Player1 のみ active（フル電池3枚）にし、他は shutdown に設定
      const updates: Record<string, unknown> = {};
      playerKeys.forEach((k, i) => {
        if (i === 0) {
          // Player1: フル電池3枚持ち
          updates[`players/${k}/hand`] = [
            { type: 'full' }, { type: 'full' }, { type: 'full' }
          ];
          updates[`players/${k}/status`] = 'active';
        } else {
          updates[`players/${k}/status`] = 'shutdown';
          updates[`players/${k}/hand`] = [{ type: 'empty' }];
        }
      });

      await fetch(`${FIREBASE_DB_URL}/rooms/${roomCode}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      // ゲームを終了させる
      await fbPut(`rooms/${roomCode}/status`, 'ended');

      // リザルト画面を確認
      await pages[0].waitForSelector('#end-screen.active', { timeout: 20000 });

      const endContent = await pages[0].locator('#end-content').textContent({ timeout: 10000 });

      // Player1が勝者として表示される
      expect(endContent).toContain('WINNER');
      expect(endContent).toContain('Player1');

      // MVPはフル電池最多のPlayer1
      expect(endContent).toContain('MVP');
      expect(endContent).toContain('Player1');
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});
