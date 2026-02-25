# codexclaw

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

このコードの大部分は GPT-5.3-Codex-xhigh で書かれており、Codex と一緒に継続して編集・改善できます。  
このプロジェクトは Codex/Qwen/Ollama/OpenRouter + Telegram 連携にフォーカスしています。  
このプロジェクトは、より大きな OpenClaw プロジェクトから必要な部分だけを抽出して作成しています。  
OpenClaw は MIT ライセンス([openclaw/openclaw](https://github.com/openclaw/openclaw))で公開されており、このプロジェクトも同じです。

最小構成のオンボーディング + ランタイム:

1. provider 選択(OpenAI Codex、Qwen、Ollama、OpenRouter)
2. provider ごとのモデル選択
3. Telegram ボットブリッジ
4. 任意: Notion スキル API キー設定
5. 任意: Web ツール(`web_search`, `web_fetch`)設定
6. 任意: スケジューラーツール(`schedule_create`, `schedule_list`, `schedule_delete`)設定
7. ワークスペースファイルスキル(`workspace_files`)によるメモリ/指示ファイル管理

<table>
  <tr>
    <td align="center" width="50%">
      <a href="images/telegram-chat-01.jpg">
        <img src="images/telegram-chat-01.jpg" width="260" alt="Telegram chat 01" />
      </a>
    </td>
    <td align="center" width="50%">
      <a href="images/telegram-chat-02.jpg">
        <img src="images/telegram-chat-02.jpg" width="260" alt="Telegram chat 02" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="images/telegram-chat-03.jpg">
        <img src="images/telegram-chat-03.jpg" width="260" alt="Telegram chat 03" />
      </a>
    </td>
    <td align="center" width="50%">
      <a href="images/telegram-chat-04.jpg">
        <img src="images/telegram-chat-04.jpg" width="260" alt="Telegram chat 04" />
      </a>
    </td>
  </tr>
</table>

## インストール

```bash
git clone https://github.com/jong-choi/codexclaw.git
cd codexclaw
npm install
```

## Docker

プロジェクトルートで CodexClaw スタックを起動(`codexclaw_shared` ネットワークは自動作成):

```bash
docker compose up --build -d
```

別フォルダで Ollama スタックを起動:

```bash
cd deploy/ollama
docker compose up -d
```

オンボーディングまたは `/provider ollama` でのエンドポイント入力:

- 同一 Docker ネットワーク(`codexclaw_shared`): `http://ollama:11434`
- Ollama がホストで稼働: `http://127.0.0.1:11434` (コンテナ内からは `http://host.docker.internal:11434` も可)
- Ollama が別サーバーで稼働: コンテナから到達可能な `http(s)://<host>:<port>`

Ollama コンテナ内でモデル pull/list:

```bash
cd deploy/ollama
docker compose exec ollama ollama pull gpt-oss:20b
docker compose exec ollama ollama list
```

スタック停止:

```bash
# モードA (リポジトリルートで実行)
docker compose down

# Ollama スタック (deploy/ollama で実行)
cd deploy/ollama
docker compose down
```

オンボーディング実行(対話式 provider 設定: Codex/Qwen は OAuth、Ollama は endpoint 入力、OpenRouter は API キー + 無料モデルスキャン):

```bash
# リポジトリルートで実行
docker compose run --rm codexclaw onboard
```

Docker で Telegram ボット実行(対話式、ペアリングコード入力に推奨):

```bash
# リポジトリルートで実行
docker compose run --rm codexclaw telegram run
```

この対話ターミナルで `bye` または `exit` を入力すると、ボットプロセスを停止してシェルへ戻ります(`\`/bye\``, `\`/exit\``も可)。

推奨フロー:
- 初回: `--rm` の対話モードでターミナルからペアリングコードを承認
- ペアリング完了後: 分離モード(`-d`)で実行し、サーバーで常駐

分離モードで Telegram ボット実行:

```bash
docker compose run -d --name codexclaw-telegram codexclaw telegram run
docker logs -f codexclaw-telegram
```

分離ボットの停止:

```bash
docker stop codexclaw-telegram
docker rm codexclaw-telegram
```

重要:
- 1つのトークンに対して Telegram polling インスタンスは1つだけ起動してください。
- 別のボットインスタンスが実行中のときは `docker compose run --rm codexclaw telegram run` を実行しないでください。

マスク済み設定を表示:

```bash
docker compose run --rm codexclaw config show
```

クリーンアップヘルパー(対話式):

```bash
./scripts/uninstall.sh
```

ワークスペースリセットヘルパー:

```bash
./scripts/reset-workspace.sh
```

このスクリプトはワークスペースディレクトリのみを初期化し、`MEMORY.md` / `INSTRUCTIONS.md` を再作成します。  
現在のワークスペースを削除して `.codexclaw/initial-workspace` からコピーし、最後に `MEMORY.md` と `INSTRUCTIONS.md` を必ず用意します。

スクリプトは最初に既存リソースを確認し、項目ごとに確認します:
- 実行中のプロジェクトコンテナ -> `docker compose down` を実行するか
- プロジェクトイメージ -> イメージを削除するか
- プロジェクトボリューム -> ボリュームを削除するか
- ワークスペースファイル(`.codexclaw/workspace`) -> ワークスペースを初期化するか
- グローバル設定(`~/.codexclaw`) -> グローバル設定を削除するか

注意:
- そのカテゴリに何も存在しない場合、その質問はスキップされます。
- プロジェクトのソースファイルは削除しません。

## オンボーディング

```bash
npm run onboard
```

Provider 設定は provider によって異なります:
- OpenAI Codex: コールバック URL の手動貼り付け
- Qwen: device-code ログイン(URLを開く + 承認 + 自動ポーリング)
- Ollama: base URL を入力し、検出されたモデル一覧から選択(`同一 Docker ネットワークなら http://ollama:11434`)
  - まだ pull 済みモデルがなくても、オンボーディングは継続できます。
  - 後で Telegram で `/ollama pull gpt-oss:20b` -> `/models` -> `/model <id|番号>` を実行してください。
- OpenRouter: API キー + base URL(既定値 `https://openrouter.ai/api/v1`)を入力し、無料モデルを動的にスキャン/選択
  - 無料モデル判定(OpenClaw 準拠): モデル ID が `:free` で終わる、または prompt/completion 価格が 0。

設定はデフォルトで `~/.codexclaw/config.json` に保存されます。  
Telegram アクセスはデフォルトで openclaw スタイルのペアリング(`dmPolicy: "pairing"`)です:
- Telegram でボットに DM を送る
- ボットがペアリングコードを返信
- 実行中の `npm run telegram` ターミナルにコードを入力して Enter
- 空行は「コードなし」(無視)
- 実行中ターミナルで `bye` または `exit` を入力すると停止(`\`/bye\``, `\`/exit\``も可)

会話履歴は `~/.codexclaw/telegram-conversations.json` に保存されます。

Notion (任意):
- オンボーディング中に `notion` スキルを有効化し、Notion integration token を保存できます。
- トークン保存先: `skills.entries.notion.apiKey`
- 設定済みの場合、アシスタントは内蔵の `notion_api_request` ツールで Notion REST を利用できます。

Web ツール (任意):
- オンボーディング中に `web_search` と `web_fetch` を有効化できます。
- `web_search` は Brave Search API(`skills.entries.web_search.apiKey` または `BRAVE_API_KEY`)を使用します。
- `web_fetch` はページ本文を抽出します(API キー不要)。

スケジューラー (任意):
- オンボーディング中に `scheduler` スキルを有効化できます。
- `schedule_create`: 遅延または絶対時刻での単発スケジュール
- `schedule_list`: 登録済みジョブを確認
- `schedule_delete`: 単発ジョブを1件キャンセル
- `schedule_recurring_create`: 繰り返しリマインダー登録(`daily`/`weekly`)
- `schedule_recurring_list`: 登録済み繰り返しリマインダー確認
- `schedule_recurring_delete`: 繰り返しリマインダーを1件キャンセル
- `schedule_recurring_pause`: 繰り返しリマインダーを一時停止
- `schedule_recurring_resume`: 一時停止した繰り返しリマインダーを再開
- チャットのタイムゾーンツール: `timezone_get`, `timezone_set`, `current_time_get`
- タイムゾーンはオンボーディングではなく、Telegram チャット中(`timezone_set`)に設定します。
- `schedule_create.prompt` と `schedule_recurring_create.prompt` は、元の予約文ではなく未来実行時の指示文にしてください。
  例: `Schedule a reminder for 8 AM tomorrow to call my mom` -> `Tell the user to call their mom now.`
- スケジュールはチャット単位で動作し、時刻到達時に新しい Codex 実行をトリガーします。

ワークスペースファイル (常時利用可能):
- CodexClaw は `workspace_read_file`, `workspace_write_file`, `workspace_delete_path` を提供します。
- デフォルトのワークスペースルート: `./.codexclaw/workspace`(実行ディレクトリ基準)
- デフォルトのワークスペーステンプレート: `./.codexclaw/initial-workspace`
- `.codexclaw/workspace` はデフォルトで gitignore 対象です。
- 任意設定: config の `workspace.root` で上書き可能
- オンボーディング時、ワークスペースが空ならテンプレートをコピーします。
- 既に空でない場合、テンプレートで初期化するか確認します。
- セッション初回ターンで、システムプロンプトが Codex に `MEMORY.md` と `INSTRUCTIONS.md` の確認を指示します。
- これらが無い場合はランタイム初期化で自動作成されます。

## Telegram ボット実行

```bash
npm run telegram
```

ランタイム動作:
- チャット/セッションごとにマルチターン文脈を保持
- `/help` (`/commands`も可): コマンド一覧と使用例を表示
- `/new`, `/clear`, `/reset`: 現在チャットの文脈をクリア
- `/context`: 保存済み文脈メッセージ数を表示
- `/usage`: リアルタイム利用枠ウィンドウを表示(Codex provider のみ)
- `/think`, `/thinking`, `/reasoning`: Reasoning effort を表示/変更(`none|minimal|low|medium|high|xhigh`)
- `/provider`: 現在 provider/モデルと進行中 provider 設定状態を表示
- `/provider <id|alias|番号>`: provider を切替(Codex/Qwen は OAuth、Ollama は endpoint 入力案内、OpenRouter は API キー入力 + 無料モデルスキャン)
- `/provider cancel`: 進行中の provider 設定をキャンセル
- `/models`: 現在 provider で利用可能なモデル一覧を表示
- `/model`: 現在 provider/モデル + reasoning effort + 利用枠サマリーを表示し、`/model <id|番号>`で即時切替
- `/ollama list|pull|rm`: Ollama モデルの一覧/追加/削除
- Codex OAuth 進行中は、次の通常メッセージをコールバック URL 入力として扱います
- Ollama 設定進行中は、次の通常メッセージを Ollama base URL 入力として扱います
- OpenRouter 設定進行中は、次の通常メッセージを OpenRouter API キー入力として扱います
- 不正なコマンド/引数: 正しい使い方と `/help` を案内
- ターミナルで `bye` または `exit` 入力: `telegram run` を即停止(`\`/bye\``, `\`/exit\``も可)
- Telegram コマンドメニュー(`/`)は起動時に自動同期されます。
- 現在の UTC/ローカル時刻コンテキストが各モデルリクエストに注入されます。
- 到来したスケジュールジョブは新規入力なしで同じボットプロセス内で実行されます。
- リクエスト受信直後にボットが能動的にステータスメッセージを投稿します。
- 処理中は定期的に、またスキル/ツール呼び出し時にステータスを更新します。
- 最終的に完了/失敗ステータスを投稿し、ツール使用時はスキル実行ログも添付します。

### Telegram ステータス更新機能

CodexClaw はステータス表示をプロンプト文言ではなくランタイム機能として扱います:
- ユーザーリクエスト受信と同時にステータスメッセージ作成
- 処理中は同一メッセージを更新(`status: processing (Xs)`)
- ツールライフサイクル(start/result, method/path, success/failure)を反映
- `status: completed` または `status: failed` で終了
- ツール使用時に簡潔な `Skill execution log` を追記

タイミング:
- 定期ステータス更新間隔: `10s`
- ツールイベント後の quiet window: `8s`

言語動作:
- ユーザー入力が韓国語なら韓国語ステータス
- それ以外は英語ステータス

任意設定:
- `telegram.proactiveStatus` を `false` にすると能動ステータス更新を無効化できます。

## 設定表示(マスク済み)

```bash
npm run config
```

## 任意: カスタム設定パス

```bash
node ./bin/codexclaw.mjs onboard --config /tmp/codexclaw.json
node ./bin/codexclaw.mjs telegram run --config /tmp/codexclaw.json
```
