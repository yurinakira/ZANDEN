import { test as base, BrowserContext, Page, expect } from '@playwright/test';

export { expect } from '@playwright/test';

const FIREBASE_DB_URL = 'https://zanden-game-default-rtdb.firebaseio.com';
export const BASE_URL = 'http://localhost:3000';

// Firebase REST API でルームを削除
export async function cleanupRoom(roomCode: string) {
  try {
    await fetch(`${FIREBASE_DB_URL}/rooms/${roomCode}.json`, { method: 'DELETE' });
  } catch {
    // cleanup failure is non-fatal
  }
}

// ルーム作成（ホスト側）→ ルームコードを返す
export async function createRoom(page: Page, hostName: string, playerCount = 4): Promise<string> {
  await page.click('button:has-text("CREATE ROOM")');
  await page.fill('#host-name', hostName);
  await page.selectOption('#player-count-sel', String(playerCount));
  await page.click('#create-form button:has-text("CREATE")');
  const el = await page.waitForSelector('#lobby-room-code');
  const code = (await el.textContent())?.trim() ?? '';
  return code;
}

// ルーム参加（ゲスト側）
export async function joinRoom(page: Page, roomCode: string, playerName: string) {
  await page.click('button:has-text("JOIN ROOM")');
  await page.fill('#join-code', roomCode);
  await page.fill('#join-name', playerName);
  await page.click('#join-form button:has-text("JOIN")');
  await page.waitForSelector('#lobby-room-code');
}

// キャラクター選択（ロビー画面）
export async function selectChar(page: Page, charIndex: number) {
  const charBtns = page.locator('#lobby-char-grid .char-btn');
  await charBtns.nth(charIndex).click();
}

// 全プレイヤーがゲーム画面に遷移するまで待つ
export async function waitForGameScreen(pages: Page[]) {
  await Promise.all(pages.map(p => p.waitForSelector('#game-screen.active', { timeout: 20000 })));
}

// ロビー画面で全プレイヤーがキャラクターを選択し、ホストがゲームを開始する
export async function startGame(pages: Page[]) {
  for (let i = 0; i < pages.length; i++) {
    await selectChar(pages[i], i);
    // 選択が反映されるまで少し待つ
    await pages[i].waitForTimeout(500);
  }
  // ホスト（pages[0]）がSTART GAMEを押す
  const startBtn = pages[0].locator('#start-btn');
  await startBtn.waitFor({ state: 'visible' });
  // STARTボタンが有効になるまで待つ
  await expect(startBtn).toBeEnabled({ timeout: 15000 });
  await startBtn.click();
  await waitForGameScreen(pages);
}

// Firebase REST API でパスのデータを取得
export async function fbGet(path: string) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
  return res.json();
}

// Phase7をFirebase REST APIで直接セットし、全消費処理を実行する
// （Phase 6 のアクション実行を丸ごとスキップできる）
export async function jumpToPhase7AndProcess(pages: Page[], roomCode: string) {
  const players = await fbGet(`rooms/${roomCode}/players`);
  const playerKeys: string[] = Object.keys(players).sort(
    (a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0)
  );

  await fetch(`${FIREBASE_DB_URL}/rooms/${roomCode}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 7,
      deck: null,
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

  for (let i = 0; i < playerKeys.length; i++) {
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
      .locator('#cm-content button:has-text("再起動しない")')
      .isVisible()
      .catch(() => false);

    if (isShutdown) {
      await consumePage
        .locator('#cm-content button:has-text("再起動しない（スキップ）")')
        .first()
        .click();
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

// リーダーのページを特定する
export async function findLeaderPage(pages: Page[]): Promise<{ leaderPage: Page; leaderIdx: number }> {
  for (let i = 0; i < pages.length; i++) {
    const ctrl = pages[i].locator('#g-controls');
    const text = await ctrl.textContent();
    if (text && text.includes('次のフェーズへ')) {
      return { leaderPage: pages[i], leaderIdx: i };
    }
  }
  // wait-modal を閉じてリーダーを再検索
  return { leaderPage: pages[0], leaderIdx: 0 };
}

// 4ブラウザコンテキストを生成するフィクスチャ型
type GameFixtures = {
  gameContexts: { pages: Page[]; contexts: BrowserContext[]; roomCode: string };
};

// 4プレイヤーのセットアップ（ルーム作成〜ロビー参加まで）
export const test = base.extend<GameFixtures>({
  gameContexts: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];

    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE_URL);
      contexts.push(ctx);
      pages.push(page);
    }

    // Player1 がルームを作成
    const roomCode = await createRoom(pages[0], 'Player1', 4);

    // Player2〜4 が参加
    await joinRoom(pages[1], roomCode, 'Player2');
    await joinRoom(pages[2], roomCode, 'Player3');
    await joinRoom(pages[3], roomCode, 'Player4');

    // 全員のロビーに4人揃うのを待つ
    await Promise.all(
      pages.map(p =>
        p.waitForFunction(
          () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
          { timeout: 20000 }
        )
      )
    );

    await use({ pages, contexts, roomCode });

    // クリーンアップ
    await cleanupRoom(roomCode);
    for (const ctx of contexts) {
      await ctx.close();
    }
  },
});
