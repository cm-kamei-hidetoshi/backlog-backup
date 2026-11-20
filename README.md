# backlog-backup

[backlog-exporter](https://github.com/ShuntaToda/backlog-exporter) を使って、複数の Backlog プロジェクトの課題・Wiki・ドキュメントを Markdown でバックアップするスクリプトです。初回はフル取得し、2 回目以降は差分だけを更新します。

添付ファイルは取得しません。

## 準備

依存パッケージをインストールします。

```bash
pnpm install
```

設定ファイルを作り、ドメインとプロジェクトキーを書き換えます。

```bash
cp projects.example.json projects.json
```

Backlog の API キーを `BACKLOG_API_KEY` に設定します。`projects.json` には書きません。方法は 2 つあります。

- 環境変数 `BACKLOG_API_KEY` を設定する
- リポジトリ直下に `.env` を作る(`.gitignore` で除外済み)

```bash
cp .env.example .env
```

両方ある場合は環境変数が優先されます。

## 設定ファイル `projects.json`

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
    { "projectIdOrKey": "PROJ_B", "targets": ["issues", "wiki"] }
  ]
}
```

| 項目 | 内容 |
| --- | --- |
| `domain` | Backlog のドメイン(必須) |
| `outputDir` | 出力先。省略時は `./backup`。相対パスは設定ファイルの場所が基準 |
| `defaults` | 全プロジェクト共通の `targets` と `prune`。プロジェクトごとに上書きできる |
| `projects[].projectIdOrKey` | プロジェクトキー(必須)。出力先のフォルダ名にもなる |
| `targets` | 取得する種別。`issues` / `wiki` / `documents`。省略時は 3 つとも |
| `prune` | `true` にすると、Backlog 側で削除されたデータをローカルからも削除する。既定は `false` |

## 実行

```bash
pnpm backup
```

| オプション | 内容 |
| --- | --- |
| `--config <path>` | 設定ファイルの場所(既定 `./projects.json`) |
| `--output <dir>` | 出力先。設定ファイルの `outputDir` より優先 |
| `--project <key>` | 指定したプロジェクトだけを実行する(複数指定可) |
| `--full` | 差分更新ではなくフル取得し直す |
| `--dry-run` | 実行するコマンドを表示するだけで実行しない |

### コマンド例

`PROJ_A` などのプロジェクトキーは、`projects.json` に書いたものに置き換えてください。

はじめて使うときは、実行されるコマンドだけを先に確認します。Backlog にはアクセスしません。

```bash
pnpm backup --dry-run
```

1 プロジェクトだけで試します。

```bash
pnpm backup --project PROJ_A
```

設定ファイルの全プロジェクトをバックアップします。日常的に使うのはこのコマンドです。

```bash
pnpm backup
```

複数のプロジェクトを指定して実行します。

```bash
pnpm backup --project PROJ_A --project PROJ_B
```

「警告あり」になったプロジェクトをフル取得し直します。

```bash
pnpm backup --full --project PROJ_A
```

全プロジェクトをフル取得し直します。差分更新で反映されない変更を揃えるために、定期的に実行します。

```bash
pnpm backup --full
```

出力先を一時的に変えます(外付けディスクなど)。

```bash
pnpm backup --output /Volumes/Backup/backlog
```

別の設定ファイルを使います(別のスペースをバックアップする場合など)。

```bash
pnpm backup --config ./projects.other.json
```

API キーをその実行だけに渡す場合は、コマンドの前に環境変数を付けます。キーがシェルの履歴に残るので、普段は `export` 済みの環境変数を使ってください。

```bash
BACKLOG_API_KEY=xxxxxxxx pnpm backup
```

## 出力

```
backup/
├── PROJ_A/
│   ├── issues/
│   ├── wiki/
│   └── documents/
└── PROJ_B/
    ├── issues/
    └── wiki/
logs/
└── <実行日時>/<プロジェクトキー>.log
```

最後にプロジェクトごとの結果を表示します。

| 結果 | 意味 |
| --- | --- |
| 成功 | 警告なく完了した |
| 警告あり | 完了したが、一部の課題やページの取得に失敗した可能性がある |
| 失敗 | 認証エラーなどで取得できなかった。残りのプロジェクトは続行する |

終了コードは、失敗が 1 件でもあれば 1、設定の誤りは 2、それ以外は 0 です。

## 注意点

- **「警告あり」のプロジェクトは `--full` で取り直してください。** 取得に失敗した項目は、次回以降の差分更新では拾われません。再実行するコマンドは結果の下に表示されます。
- **差分更新では反映されない変更があります。** 親課題を付け替えた子課題の元の親などです。定期的に `--full` を実行すると揃います。
- **`targets` から種別を外しても、取得済みのフォルダは更新され続けます。** 止めるにはそのフォルダを削除してください。
- **対象は 1 つのスペースです。** 別のスペースをバックアップする場合は、設定ファイルと出力先を分け、`--config` で切り替えてください。
