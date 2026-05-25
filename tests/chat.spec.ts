import { test, expect, cleanupRoom, createRoom, joinRoom, selectChar, startGame, waitForGameScreen, BASE_URL } from './setup';
import { Page } from '@playwright/test';

// ============================================================
// シナリオ6：チャット（アピールタイム）
// ============================================================
test.describe('シナリオ6：チャット（アピールタイム）', () => {
  test('Phase4でチャットを送信すると全員のブラウザにメッセージが表示される', async ({ browser }) => {
    const contexts = [];
    const pages: Page[] = [];
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE_URL);
      contexts.push(ctx);
      pages.push(page);
    }

    let roomCode = '';
    try {
      roomCode = await createRoom(pages[0], 'Player1', 4);
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

      // リーダーを特定
      let leaderPage: Page = pages[0];
      for (let i = 0; i < pages.length; i++) {
        const ctrl = await pages[i].locator('#g-controls').textContent({ timeout: 10000 });
        if (ctrl && ctrl.includes('次のフェーズへ')) {
          leaderPage = pages[i];
          break;
        }
      }

      // Phase1 → 2 → 3 → 4（アピールタイム）に進める
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

      // 全員がPhase4に到達するまで待つ
      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
            { timeout: 15000 }
          )
        )
      );

      // Player2（pages[1]）がチャットを送信
      const testMessage = 'テストメッセージ: フル電池があります！';
      await pages[1].fill('#g-chat-inp', testMessage);
      await pages[1].click('button:has-text("SEND")');

      // 全員のブラウザにメッセージが表示されることを確認
      for (const p of pages) {
        await expect(p.locator('#g-chat')).toContainText(testMessage, { timeout: 10000 });
      }

      // クイックピルのボタンをクリックしてメッセージが送れることを確認
      await pages[1].locator('.quick-pills .pill').first().click();

      // 「支援申し出」のメッセージが全員に表示される
      for (const p of pages) {
        await expect(p.locator('#g-chat')).toContainText('フル電池があります', { timeout: 10000 });
      }
    } finally {
      if (roomCode) await cleanupRoom(roomCode);
      for (const ctx of contexts) await ctx.close();
    }
  });

  test('Enterキーでもチャット送信できる', async ({ browser }) => {
    const contexts = [];
    const pages: Page[] = [];
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE_URL);
      contexts.push(ctx);
      pages.push(page);
    }

    let roomCode = '';
    try {
      roomCode = await createRoom(pages[0], 'Player1', 4);
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

      // リーダーを特定してPhase4まで進める
      let leaderPage: Page = pages[0];
      for (let i = 0; i < pages.length; i++) {
        const ctrl = await pages[i].locator('#g-controls').textContent({ timeout: 10000 });
        if (ctrl && ctrl.includes('次のフェーズへ')) {
          leaderPage = pages[i];
          break;
        }
      }

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

      await Promise.all(
        pages.map(p =>
          p.waitForFunction(
            () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
            { timeout: 15000 }
          )
        )
      );

      // Enterキーでメッセージ送信
      const enterMsg = 'Enterキーテスト';
      await pages[2].fill('#g-chat-inp', enterMsg);
      await pages[2].press('#g-chat-inp', 'Enter');

      // 全員にメッセージが表示される
      for (const p of pages) {
        await expect(p.locator('#g-chat')).toContainText(enterMsg, { timeout: 10000 });
      }
    } finally {
      if (roomCode) await cleanupRoom(roomCode);
      for (const ctx of contexts) await ctx.close();
    }
  });
});
