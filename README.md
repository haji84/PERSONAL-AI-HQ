# Personal AI HQ

Personal AI HQは、開発案件、ChatGPTの書き出し、Codexの実スレッド、確認済み成果物を一つの画面で扱うためのユーザー専用アプリです。

## Macで起動

Node.js 24とサインイン済みのCodex CLIを利用します。最初に `npm ci --ignore-scripts` で依存関係を揃えます。`start-mac.command` はMacのブラウザーでサインイン用ファイルを開き、`npm start` はURLとサインイン用ファイルの場所を表示します。標準URLは `http://127.0.0.1:4328/` です。

案件の読み取り元は、プライベートな実行ディレクトリの `portfolio.json` です。Macの標準ディレクトリは `~/Library/Application Support/Personal AI HQ/integration` です。`HQ_PRIVATE_DIRECTORY` と `HQ_PORT` で動作確認用ディレクトリとポートを選べます。サインイン用ファイルと会話データは本人の実行ディレクトリに保存されます。

## Windowsで起動

Node.js 24以降とCodex Desktopを使います。`npm ci --ignore-scripts` の後、`start-windows.cmd` を開くと、URLと本人用のサインインファイルが表示されます。ファイルをブラウザーで開いてサインインします。Windowsの標準保存先は `%LOCALAPPDATA%\PersonalAIHQ\integration` です。起動時に既存のWindowsアクセス権を確認し、新しく作った実行ディレクトリだけを本人・SYSTEM・管理者に限定します。変更前後の権限はそのディレクトリに保存します。既存ディレクトリの権限を変更して起動を通すことはありません。

Windows版は、Desktop同梱の公式App Serverから実履歴と対応モデルを読み取ります。現在は閲覧用です。Macで確認済みの独立実行接続を、Windowsの実行確認と同じ扱いにはしません。

## 接続と確認範囲

- ダッシュボードに出典、観測日時、確認済みの成果と残作業を表示します。進捗の出典がなければ不明と表示します。
- チャットには対象案件を選んでChatGPT公式書き出しの `conversations.json` を取り込みます。取得元と取り込み時刻を表示し、履歴のタイトルと本文から検索できます。
- Codexは公式App Serverから対象案件のスレッドと選べるモデルを読み取ります。対象案件の実行ディレクトリを `portfolio.json` の案件に指定します。
- 成果物では、読取確認済みのURLと、実行ディレクトリで登録したファイルを取得できます。

## Codexで実行する

標準起動は履歴の読み取りです。Macで既存のChatGPTプランを使って実行を許可するには、同じ利用者の独立したCodex App Serverを非公開のUnixソケットで起動し、`HQ_CODEX_SOCKET` にその絶対パスを指定します。アプリを終了しても独立したCodexプロセスは動作を続けます。

対象案件の `cwd` に非公開の実行ディレクトリ内の `workspaces/<案件ID>` を指定し、`enableCodexWrite` を `true` にします。その作業先のルートに案件IDだけを書いた `.hq-owned-workspace` がある場合に送信できます。操作画面から新規指示、中断、同じスレッドでの再開と完了後の追加指示ができます。ネイティブの作業先とターンIDを照合し、応答が途切れた場合は履歴に保存された受付IDで確認します。確認できない送信は保留し、自動再送を行いません。

Codexの書き込みは指定作業先のワークスペースに制限されます。ファイルの読み取りにはCodex本体のサンドボックスと管理設定が適用されます。ネイティブの承認が必要な操作には、現在のCodexクライアントで対応してください。

別の端末でローカルに読み取る場合は、本人専用の `HQ_PRIVATE_DIRECTORY` にその端末向けの `portfolio.json` を用意して `npm start` を使います。独立した実行接続はMacのUnixソケットで確認済みです。公開・遠隔利用の受入条件は [GOAL](GOAL.md) と [公開リポジトリの安全管理](docs/SECURITY.md) にあります。

## 検証

`npm test` で本人認証、案件別の履歴保存と再起動、時間・進捗計算、送信の重複防止を検証します。Macの既存サインインで分離した作業先の実行・中断・再開を確認する場合は `node verification/native-codex.mjs` を使います。このコマンドは実際にCodexの利用枠を消費します。ChatGPTとCodexの公式接続仕様は [ChatGPTデータ書き出し](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) と [Codex App Server](https://learn.chatgpt.com/docs/app-server) を参照してください。
