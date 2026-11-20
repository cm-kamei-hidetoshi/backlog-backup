# Backlog 複数プロジェクト バックアップスクリプト 実装計画

## 1. 目的

[backlog-exporter](https://github.com/ShuntaToda/backlog-exporter)(v1.3.0、導入済み)を使い、設定ファイルに列挙した複数の Backlog プロジェクトの課題・Wiki・ドキュメントを、1 コマンドでローカルにバックアップする。2 回目以降は差分更新にする。

## 2. backlog-exporter の挙動(インストール済みコードで確認した内容)

| 項目 | 確認結果 | スクリプトへの影響 |
| --- | --- | --- |
| 設定ファイルの場所 | `all` は出力先直下ではなく `issues/` `wiki/` `documents/` のそれぞれに `backlog-settings.json` を作る | 初回か 2 回目以降かは、この 3 ファイルの有無と `lastUpdated` で判定する |
| API キーの保存 | `backlog-settings.json` には保存されない | バックアップ先に秘密情報は残らない。毎回環境変数で渡す |
| `all` の対話プロンプト | `--only` も `--exclude` も無く、標準入力が TTY のときだけ Wiki/ドキュメントの選択を聞く | 常に `--only` を付けて呼ぶ |
| `update` の確認プロンプト | `--force` が無いと y/n を聞く | 常に `--force` を付ける |
| `--maxCount` | 実際には 1 ページあたりの件数(上限 100)にしか使われず、全件をページングで取得する | 5000 件超でも切り捨ては無い。指定しない |
| 致命的エラー | 認証失敗や一覧取得の失敗は非 0 で終了する | 終了コードでプロジェクト単位の失敗を判定できる |
| 個別エラー | 課題 1 件、Wiki 1 ページ、添付 1 ファイルの失敗は警告だけで、終了コードは 0 | 終了コードだけでは不十分。出力の警告も拾って「警告あり」として報告する |
| `update` のスキップ | 設定ファイルや API キーが無い場合も警告だけで終了コード 0 | 同上。`update` を呼ぶ前にスクリプト側で設定ファイルを検査する |
| `update` の対象 | 指定ディレクトリ配下を再帰的に探索し、見つけた設定ファイルごとに更新する | プロジェクトのディレクトリを 1 回渡せば 3 種別とも更新される |
| API キーの読み取り | `--apiKey` が無ければ環境変数 `BACKLOG_API_KEY` を使う | スクリプトは環境変数をそのまま子プロセスに引き継ぐ |

README にある `--statusId` は `all` のヘルプに出てこないため、使わない。

## 3. 構成

```
backlog-backup/
├── backup.mjs              # バックアップ本体
├── projects.json           # 対象プロジェクトの一覧(Git 管理する)
├── projects.example.json   # 記入例
├── .gitignore              # backup/, logs/, .env
├── backup/                 # 出力先(既定)
│   ├── PROJ_A/{issues,wiki,documents}/   # プロジェクトごとに 1 フォルダ
│   └── PROJ_B/{issues,wiki,documents}/
└── logs/                   # 実行ログ
    └── <実行日時>/<projectKey>.log
```

既存の `package.json` が pnpm と `"type": "module"` なので、Node.js の `.mjs` スクリプト 1 本で実装する。追加の依存パッケージは入れない。`package.json` に `"backup": "node backup.mjs"` を追加し、`pnpm backup` で実行する。

## 4. 設定ファイル `projects.json`

```json
{
  "domain": "example.backlog.jp",
  "outputDir": "./backup",
  "defaults": {
    "targets": ["issues", "wiki", "documents"],
    "prune": false
  },
  "projects": [
    { "projectIdOrKey": "PROJ_A" },
    { "projectIdOrKey": "PROJ_B", "targets": ["issues", "wiki"] },
    { "projectIdOrKey": "PROJ_C" }
  ]
}
```

- `defaults` の値を各プロジェクトで上書きできる。
- `outputDir` は省略でき、既定は `./backup`。任意の場所(絶対パスも可)に変えられる。
- API キーは設定ファイルに書かない。環境変数 `BACKLOG_API_KEY` か `.env` で渡す。
- 対象は 1 つのスペース(`domain` は 1 つ)とする。
- 起動時に検証する。必須項目の欠落、`targets` の不正値、`projectIdOrKey` の重複、`BACKLOG_API_KEY` の未設定は、何も実行せずにエラーで終了する。

## 5. 処理の流れ

1. スクリプトと同じ場所の `.env` を読み込み(あれば)、`BACKLOG_API_KEY` があることを確認する。環境変数が既にあればそちらを優先する。
2. `projects.json` を読み込んで検証する。
3. プロジェクトを 1 件ずつ順番に処理する。backlog-exporter 自体が並列取得とレート制限の待機をするため、プロジェクト間は並列にしない。
   1. 出力先を `<outputDir>/<projectIdOrKey>/` とする(プロジェクトごとに 1 フォルダ)。
   2. `targets` の各種別について `backlog-settings.json` に `lastUpdated` があるかを見る。
      - すべてある場合は差分更新: `backlog-exporter update <出力先> --force`
      - 1 つでも無い場合はフル取得: `backlog-exporter all --domain … --projectIdOrKey … --output <出力先> --only <targets>`
      - `all` が途中で失敗すると、後続の種別は設定ファイルが作られず、`update` では永久に取得されない。そのためこの判定にしている。
   3. `prune` が true の場合だけ、成功後に `backlog-exporter prune <出力先> --force` を実行する。
   4. 標準出力と標準エラーを画面とログファイルの両方に流す。
   5. 終了コードと警告の件数を記録する。失敗しても次のプロジェクトへ進む。
4. 最後にプロジェクトごとの結果(成功 / 警告あり / 失敗、所要時間、ログの場所)を一覧表示する。失敗が 1 件でもあれば終了コード 1 で終わる。

子プロセスは `node_modules/.bin/backlog-exporter` を `child_process.spawn` で起動する。シェルは経由しない。

### API キーの渡し方

実行前に環境変数 `BACKLOG_API_KEY` を設定しておく。スクリプトはそれを子プロセスに引き継ぐだけで、`--apiKey` は使わない(プロセス一覧に見えてしまうため)。設定ファイルにもログにも書かない。

```bash
pnpm backup
```

`BACKLOG_API_KEY` はシェルの設定やシークレット管理ツールなどで、あらかじめ export しておく。

### コマンドラインオプション

| オプション | 内容 |
| --- | --- |
| `--config <path>` | 設定ファイルの場所(既定 `./projects.json`) |
| `--project <key>` | 指定したプロジェクトだけを実行する(複数指定可) |
| `--full` | 設定ファイルの有無にかかわらず `all` でフル取得する |
| `--output <dir>` | 出力先を指定する(`projects.json` の `outputDir` より優先) |
| `--dry-run` | 実行するコマンドを表示するだけで実行しない |

## 6. 方針として決めたこと

- **`prune` は既定で無効にする。** `prune` は Backlog 側で消えたデータをローカルからも消すため、バックアップの目的と逆に働く。必要なプロジェクトだけ有効にする。
- **添付ファイルは取得しない。** `-d` は付けず、設定項目も設けない。Markdown には添付ファイルの名前とサイズだけが残る。
- **警告が出たプロジェクトはフル取得し直す。** backlog-exporter は個別の課題やページの保存に失敗しても `lastUpdated` を更新するため、失敗した項目は次回以降の差分更新で拾われない。結果一覧に「警告あり」と再実行コマンド(`pnpm backup --full --project <key>`)を表示する。
- **`targets` から外した種別は自動では止まらない。** `update` は設定ファイルのあるフォルダをすべて更新するため、`targets` から種別を外しても既存フォルダの更新は止まらない(不要ならフォルダを消す)。
- **差分更新の限界は残る。** `update` は、親課題を付け替えた子課題の元の親など、一部を書き直さない。定期的に `--full` で取り直す運用で補う。

## 7. 実装手順

1. `.gitignore` と `projects.example.json` を作る。
2. `backup.mjs` を実装する。設定の読み込みと検証、実行するコマンドの組み立て、子プロセスの実行とログ、結果の一覧表示の順に作る。
3. `package.json` に `backup` スクリプトを追加する。
4. `README.md` に準備と実行方法を書く。
5. 動作確認をする(次節)。

## 8. 動作確認

- `--dry-run` で、初回は `all`、2 回目は `update` のコマンドが組み立てられること。
- 実際のプロジェクト 1 件で初回実行し、`issues/` `wiki/` `documents/` と各 `backlog-settings.json` ができること。
- 続けて再実行し、差分更新になり、プロンプトで止まらないこと。
- 存在しないプロジェクトキーを 1 件混ぜ、そのプロジェクトだけ失敗して残りは完了し、終了コードが 1 になること。
- `BACKLOG_API_KEY` を外すと、何も実行せずにエラーで終わること。

実装時に確認する点が 1 つ残っている。

- ドキュメント機能や Wiki が無効なプロジェクトで `all` がどう終わるか。失敗する場合は、そのプロジェクトの `targets` から外す運用にする。

警告行は、oclif が標準エラーに出す `›   Warning:` で始まる行として判定する(実際の出力で確認済み)。

## 9. 今回の対象外

- 定期実行の設定(cron、launchd など)
- 添付ファイルの取得
- 複数スペース(複数ドメイン、複数 API キー)への対応
- S3 などへの転送、世代管理、圧縮
- Git リポジトリ、共有ファイル、Subversion のバックアップ(backlog-exporter が扱わない)
