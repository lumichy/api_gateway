# サブスクリプション AI ゲートウェイ（subscription-ai-gateway）

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## このプロジェクトについて

**個人がローカルで実行する AI ゲートウェイ**です。複数の AI プロバイダー（サブスクリプションアカウントまたは API サービス）を、OpenAI 互換の単一エンドポイントにまとめます。クライアントの接続先は常に `http://127.0.0.1:8787/v1` です。`auto` を使用すると、ゲートウェイが対応機能、利用枠、稼働状態に基づいてプロバイダーを選び、利用枠の枯渇、レート制限、認証失敗、一時的な障害が発生した場合にフォールバックを試みます。

主な機能：

- **統一エンドポイント**：標準の `/v1/chat/completions` を提供。OpenAI クライアント SDK と互換性があり、SSE ストリーミングに対応
- **自動ルーティング**：残りの利用枠によるスコアリング、クールダウンによる隔離、同時実行枠の予約。非ストリーミングでは成功するまでエラー種別に応じてフォールバックでき、ストリーミングでは chunk を一つでも出力した後はプロバイダーを切り替えない
- **利用枠テレメトリー**：公式経路からの取得を優先し、取得できなければ `unknown` と表示。架空の残高は生成しない
- **対応機能に応じたルーティング**：互換 API には tools、マルチモーダルメッセージ、拡張パラメーターを転送。CLI が対応していないリクエストは明示的に 400 を返し、auto はそのリクエストに対応するプロバイダーだけを選択

サービスの対象は**単一ユーザーのローカル利用**です。ループバックアドレスのみで待ち受け、すべてのクライアントが同じキーと利用枠を共有します。会話メモリーや固定ルーティングはありません。複数人での共有やマルチテナント構成には適していません。

実装：Node.js ≥ 24 で TypeScript を直接実行します。**サードパーティーのランタイム依存はゼロ**（`node:http`、`node:sqlite`、`node:child_process` などの組み込みモジュールのみ）で、ビルドは不要です。

## インストール

```powershell
git clone <リポジトリのURL> api_gateway
cd api_gateway
```

Node.js 24 以降が必要です。ランタイム依存がないため、`npm install` は不要です（開発時に型チェックと整形用の TypeScript/Prettier をインストールする場合のみ使用します）。

環境の確認：

```powershell
node --version          # v24+ が必要
node scripts/doctor.ts --config config.example.json
```

`doctor` は起動前の診断ツールです。設定ファイルを検証し、有効なプロバイダーの実行ファイル、認証情報用の環境変数、一部 CLI のログイン状態を確認します。推論リクエストは送信せず、キーも表示しません。上流への接続、モデルの利用権限、残りの利用枠を保証するものではありません。

## 設定

### 1. キーの準備

ゲートウェイは独立した 2 つの長いキーを使用します（いずれも ≥ 24 文字が必要）：

- `GATEWAY_KEY`：クライアントが推論 API を呼び出すためのキー
- `GATEWAY_ADMIN_KEY`：管理 API 用のキー（状態確認、利用枠の手動登録、ブロック解除）

2 つのキーは同じ値にできません。同じ値にすると、呼び出し用キーを持つ人が管理 API も操作できてしまいます。

設定ファイルには**環境変数名だけを保存**します。キーの値は常に環境変数から取得するため、設定ファイルは安全にコミットできます。非公開の環境変数ファイル（コミット対象から除外済みの `.env.local` など）の使用を推奨します：

```
GATEWAY_KEY=24文字以上のランダムな値
GATEWAY_ADMIN_KEY=別の24文字以上のランダムな値
```

### 2. 設定ファイルの作成

テンプレートをコピーして編集します：

```powershell
Copy-Item config.example.json config.local.json
```

トップレベルのフィールド：

| フィールド | デフォルト | 説明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | `127.0.0.1` または `::1` のみ許可。それ以外は起動時に失敗 |
| `port` | `8787` | 1–65535 |
| `statePath` | `data/gateway.sqlite` | SQLite 状態データベース。相対パスの基準は設定ファイルのディレクトリ |
| `gatewayKeyEnv` / `adminKeyEnv` | `GATEWAY_KEY` / `GATEWAY_ADMIN_KEY` | 環境変数名 |
| `timeoutMs` | `120000` | リクエスト全体の時間制限（すべてのフォールバック試行を含む）、100–600000 |
| `quotaTtlMs` | `60000` | 利用枠スナップショットの有効期間、100–3600000 |
| `providers` | — | プロバイダー一覧、1–32 件 |

現在の `config.example.json` には、このマシンのモデル、スイッチ、実行ファイルのパスが含まれています。すべてを無効にした汎用テンプレートではありません。別のマシンにコピーした場合は、パス、環境変数、有効な項目を確認してください。キーの値は引き続き非公開の環境変数ファイルにのみ保存されます。

各プロバイダーの共通フィールド：

| フィールド | 説明 |
| --- | --- |
| `id` | 一意の小文字識別子。ルーティングエイリアスの接頭辞にも使用（`id/model`） |
| `type` | `openai-compatible` / `codex` / `claude` / `codebuddy` / `antigravity` |
| `models` | モデル一覧（1–64 件）。`openai-compatible` では `/` を使用可能（例：`nvidia/model:free`）。他の種類では `/` を禁止。`auto` は一覧の最初のモデルを使用 |
| `enabled` + `billingVerified` | **両方を `true` にする必要がある 2 つのスイッチ**。後者は、想定した課金経路を運用者が確認済みであることを示す。CLI では対象のサブスクリプション、API では対象アカウントの無料利用枠または了承済みの API 課金を使用 |
| `allowAuto` | `auto` の自動ルーティングに参加するかどうか（各種類の説明を参照） |
| `priority` | 同点なら小さい値を優先。0–10000、デフォルト 100 |
| `maxConcurrency` | そのプロバイダーへの最大同時リクエスト数。1–32、デフォルト 1 |

実装では実際のプロバイダーはデフォルトで無効ですが、設定ファイルで明示的に有効にできます。CLI を有効にする前に、公式アカウントへのログイン、モデルの利用可否、追加の従量課金設定を確認してください。API では有効なキーを設定し、モデルの利用権限と課金を確認してから、両方のスイッチを有効にします。

現在のローカルディスク上の設定（2026-10-10）：

| Provider | `enabled` | `auto` が使用する最初のモデル | `priority` |
| --- | --- | --- | --- |
| Ark | `true` | `deepseek-v4.1-flash` | 5 |
| Agnes | `true` | `agnes-3.0-flash` | 5 |
| OpenRouter | `true` | `nvidia/nemotron-3-ultra-550b-a55b:free` | 100 |
| CodeBuddy / Antigravity / Codex / Claude | `false` | ルーティングに参加しない | 各設定による |

7 つすべての Provider に `allowAuto: true`、`maxConcurrency: 3` が設定されています。無効な Provider は引き続きルーティングに参加しません。OpenCode Zen はローカル設定から削除済みです。`config.example.json` には、前回同期時の OpenRouter が無効で最初のモデルが `openrouter/free` という設定が残っています。実際に起動時に指定した設定ファイルが適用されます。

### 3. 起動

```powershell
node --env-file=.env.local src/main.ts --config config.local.json
```

起動後は `http://127.0.0.1:<port>/v1` で待ち受けます。ゲートウェイキーの欠落、無効な設定フィールド、不正な API エンドポイント形式は起動失敗の原因になります。Provider のキー、CLI のログイン状態やバージョン、モデルの利用権限などの問題は、ヘルスチェックや実際の呼び出しで判明する場合もあります。

**`config.local.json` または `.env.local` を変更した場合は、プロセスの再起動が必要です**。現在、設定のホットリロードには対応していません。処理中のリクエストが完了してから古いプロセスを停止し、上記の起動コマンドを実行してください。ディスク上の設定と実行中の設定が異なる場合があります。`GET /admin/status` と `GET /v1/models` で、実際に有効な状態を確認できます。管理 API による利用枠の登録、更新、クールダウン解除は即時に反映され、再起動は不要です。

### 4. クライアントの接続

OpenAI Python SDK の例：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="自分の GATEWAY_KEY")
result = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "ゲートウェイのフォールバックの仕組みを説明してください"}],
)
print(result.choices[0].message.content)
```

`model` の指定方法は 3 種類です：

| 指定 | 動作 |
| --- | --- |
| `auto` | 利用枠、クールダウン、優先度に基づいて自動選択（`allowAuto` の制約を受ける） |
| `id/model`（例：`claude/sonnet`） | 指定プロバイダーに固定。失敗時は直接エラーを返し、フォールバックしない |
| その他 | 400 |

レスポンスヘッダー `x-gateway-provider` / `x-gateway-model` は、実際のプロバイダーとモデルを示します。レスポンス本文の `model` は、クライアントが指定したエイリアス（`auto` を含む）を保持します。再試行可能な時刻がわかるエラーには `retry-after` ヘッダーが付きます。

### `auto` の選択順序

1. 有効、課金確認済み、`allowAuto: true` の Provider だけを対象とし、各 Provider の `models[0]` を使用します。同じ Provider のモデル一覧内でランダムに切り替えることはありません。
2. ヘルスチェックと利用枠の照会前に、リクエストの対応機能で絞り込みます。ツール、マルチモーダル、生成パラメーターなどの拡張リクエストは互換 API にのみ送ります。`auto` を使用しても CLI にこれらの機能が追加されるわけではありません。
3. ヘルスチェックに失敗した候補、クールダウン中の候補、利用枠がゼロと判明している候補を除外します。手動登録以外の利用枠が欠落または期限切れの場合は照会を試みます。照会に失敗しても未知のままとし、利用枠が枯渇したとは判断しません。
4. 有効期間内の既知の利用枠を、未知の利用枠より優先します。複数の利用枠ウィンドウがある場合は残りの割合の最小値をスコアとし、高いものを優先します。同点またはすべて未知の場合は `priority` の昇順、次に Provider ID のアルファベット順で並べます。
5. この順序で同時実行枠と予算の予約を試みます。その Provider の枠が埋まっていれば次へ進みます。各 Provider は最大 1 回だけ試行します。フォールバック可能なエラーなら次へ進み、パラメーターエラーや未対応エラーなら直接返します。ストリーミングの出力開始後は切り替えられません。

たとえば現在のディスク上の設定では、OpenRouter から有効期間内かつゼロでない無料の 1 日あたりリクエスト枠を取得できた場合、`priority` が 100 でも、利用枠が未知の Agnes と Ark より先に選ばれます。3 社すべての利用枠が未知なら、順序は Agnes → Ark → OpenRouter です。Agnes と Ark はどちらも 5 のため、ID 順になります。この順序は利用枠、クールダウン、同時実行状況、リクエストの対応機能によって変わります。

## プロバイダーの設定

プロバイダーは 5 種類です。CLI 系（claude / codebuddy / antigravity / codex exec）には次の共通制約があります：

- **単一ターン**：user メッセージ 1 件と、任意の先頭 system 指示 1 件のみを受け付けます。`auto` の複数ターンリクエストは、構造化された履歴に対応するプロバイダー（openai-compatible / codex responses）に絞り込まれます。明示的な CLI エイリアスではフォールバックせず、未対応の履歴を直接拒否します
- **バージョン依存**：Claude と Codex exec は検証済みの固定バージョンを使用し、Antigravity は検証済みバージョンの許可リストを使用します。CodeBuddy は CLI の実行可否と実際のイベントプロトコルを検証します。アップグレード後は同様に再確認が必要です
- **パラメーターの許可リスト**：`command` は node.exe またはネイティブ実行ファイルのみ（shell と `.cmd` は禁止）。`args` は絶対パスの JS エントリーポイント 1 つのみ。ランタイムフラグ、設定の上書き、埋め込み prompt はすべて拒否します
- **実行時の検証**：CLI のツール無効化パラメーター、ツールを持たない専用 Agent、イベントの検査でツールを隔離します。実際のツール呼び出しや、対応 adapter の契約に違反する初期化情報が検出された場合は拒否します。Antigravity のグローバルなツール一覧は、選択した Agent のツール権限とは異なります

---

### openai-compatible —— 汎用 API 接続と拡張ポイント

**ゲートウェイの拡張性を担う仕組みです。「Bearer キー + OpenAI Chat Completions プロトコル」の HTTP サービスなら、設定を追加するだけで接続でき、コード変更は不要です。**

```json
{
  "id": "ark",
  "type": "openai-compatible",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "apiKeyEnv": "ARK_CODING_API_KEY",
  "models": ["deepseek-v4.1-flash", "glm-5.3-flash", "doubao-seed-2.1-lite"],
  "quotaSource": "ark-cli",
  "allowAuto": true,
  "enabled": false,
  "billingVerified": false,
  "priority": 10,
  "maxConcurrency": 3
}
```

要点：

- `baseUrl` には **API のルートパス**を指定します。ゲートウェイが `/chat/completions` を自動追加します。URL は安全性を検証し（http/https のみ、埋め込み認証情報・クエリ文字列・フラグメントは禁止）、リダイレクトには従いません
- **推論には同じ汎用 adapter を使用**します。火山方舟、OpenRouter、Agnes などは設定でエンドポイントとキーを指定するだけです。Provider ID に応じて選ばれる専用の推論タイプはありません。任意の利用枠取得には、別途公式ソースの制約があります
- メッセージの完全な転送：構造化された複数ターン履歴と system 指示をそのまま転送します（プロトコルをそのまま使用し、変換なし）
- **`allowAuto` のデフォルトは `false`**：API 課金サービスは token 単位で課金され、フォールバック経路で意図せず選ばれると実際の料金が発生します。自動ルーティングに参加させるには、明示的な `true` が必要です。明示的なエイリアス（`id/model`）にはこの制限は適用されません

**利用枠テレメトリーの拡張**。デフォルトの利用枠は `unknown`（ルーティング時は `priority` 順）です。任意の `quotaSource` 設定で公式テレメトリーを接続できます：

| `quotaSource` | 利用枠の取得元 | 追加要件 |
| --- | --- | --- |
| `"openrouter"` | 公式 key API：無料モデルの 1 日あたりリクエスト数、および API key の USD 使用量・支出上限 | `baseUrl` は公式の `https://openrouter.ai/api/v1` であること。USD データはウォレット残高とは異なり、無料リクエストの残数を代替しない |
| `"ark-cli"` | 公式 arkcli：返された session / weekly / monthly の percent ウィンドウ | 公式 arkcli をインストールしてログイン。`quotaCommand` でネイティブ実行ファイルを指定可能。独立したコントロールプレーンの認証情報が必要で、推論 API key では代替できない |

新しい OpenAI 互換サービスの接続に必要なのは、**JSON 設定 + 環境変数のキー + 2 つのスイッチ**だけです。サーバー側が Chat Completions プロトコルに対応していれば、コードを書く必要はありません。

Agnes はローカル設定とサンプル設定に追加済みです。モデルエイリアスは `agnes/agnes-3.0-flash`、Base URL は `https://apihub.agnes-ai.com/v1`、キーの参照先は `AGNES_API_KEY` です。このマシンでは有効化し、実際のリクエストで検証済みです。現在、`allowAuto: true`、`maxConcurrency: 3` を明示的に設定しています。利用枠の取得は未実装のため `unknown` と表示されます。新しい環境ではキーを設定し、課金を確認してください。モデルとエンドポイントは [Agnes 公式ドキュメント](https://www.agnes-ai.com/en/docs/agnes-30-flash) を参照してください。

#### Chat Completions の機能

`openai-compatible` はリクエストパラメーターとメッセージ JSON を保持します。対象は `tools`、`tool_choice`、`parallel_tool_calls`、ツール結果メッセージ、従来の `functions/function_call`、`response_format`、`temperature`、`top_p`、`stop`、`max_tokens/max_completion_tokens`、`n`、`logprobs`、`stream_options`、推論オプション、モデル提供元の拡張フィールドです。画像、音声、ファイルなどのメッセージ内容の配列もそのまま転送します。各機能の利用可否は上流モデルによって決まり、ゲートウェイはツールを実行せず、メッセージ内のメディアもダウンロードしません。

ストリーミングと非ストリーミングの両方で、すべての choices、ツール呼び出し、推論内容、拒否情報、音声、annotations、logprobs、usage の詳細、拡張レスポンスフィールドを保持します。`model` はクライアントが使用したゲートウェイのエイリアスを返します。実際のプロバイダーとモデルは `x-gateway-provider` / `x-gateway-model` を参照してください。ツール引数や回答が混在するのを防ぐため、ストリーミングの chunk を一つでも出力した後はプロバイダーを切り替えません。

Python の OpenAI クライアントでツールを呼び出す例：

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=os.environ["GATEWAY_KEY"])
messages = [{"role": "user", "content": "東京の現在の気温は何度ですか？"}]
tools = [{"type": "function", "function": {
    "name": "get_temperature", "description": "都市の気温を調べる",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                   "required": ["city"]}
}}]
result = client.chat.completions.create(
    model="ark/deepseek-v4.1-flash", messages=messages,
    tools=tools, tool_choice="auto",
)
answer = result.choices[0].message
if answer.tool_calls:
    messages.append(answer.model_dump(exclude_none=True))
    for call in answer.tool_calls:
        # ツール結果の例。実際のアプリではツール名・引数を検証し、自分のツールを実行してください。
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": '{"temperature": 20, "unit": "C"}'})
    final = client.chat.completions.create(
        model="ark/deepseek-v4.1-flash", messages=messages, tools=tools,
    )
    print(final.choices[0].message.content)
else:
    print(answer.content)
```

CLI とサブスクリプションの Responses 経路は、引き続き従来のテキスト処理のみ対応します。拡張パラメーターは黙って無視せず、`unsupported` を返します。互換 API の `allowAuto` のデフォルト値は変わりません。ツールやマルチモーダルを含む `auto` リクエストでは、有効かつ auto が許可された互換 API だけを選びます。リクエスト上限は引き続き 1 MiB、レスポンス上限は 16 MiB、単一 SSE frame の上限は 1 MiB です。

### claude

ローカルの公式 Claude Code CLI。**2.1.296** に固定しています。

```json
{
  "id": "claude",
  "type": "claude",
  "models": ["sonnet"],
  "command": "claude",
  "enabled": false,
  "billingVerified": false,
  "priority": 20
}
```

- リクエストごとに新しい一時ディレクトリで起動。`--safe-mode`、ツールなし、MCP なし、hooks・スラッシュコマンド・ブラウザー無効、セッション保存なし。`ANTHROPIC_*` / `CLAUDE_CODE_*` 環境変数を除去し、API 課金ではなくサブスクリプションのログインを使用します
- ヘルスチェックにはサブスクリプションのログイン状態（`claude.ai` + firstParty + Pro/Max）が必要です。システムレベルの管理ポリシー（managed settings / registry）を検出した場合は、起動前に直接拒否します。管理された hooks は safe mode の制約を通過できるためです
- 利用枠：公式 `rate_limit_event` ウィンドウ（5 時間、7 日間など）。ただし、**実際のリクエストのレスポンスからのみ**観測できます。独立した読み取り専用の照会はなく、リクエストを観測するまでは `unknown` です
- CLI 2.1.296 の `unifiedWindows` は実測で対応を確認済みです。複数ウィンドウの使用率とリセット時刻を読み取れます。報告されていないウィンドウは未知のままにし、架空の残りリクエスト数には換算しません

### codebuddy

ローカルの公式 CodeBuddy CLI（`scripts/login-codebuddy.ts` でログイン）。

```json
{
  "id": "codebuddy",
  "type": "codebuddy",
  "models": ["REPLACE_WITH_ACCOUNT_MODEL"],
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/path/to/.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"],
  "enabled": false,
  "billingVerified": false
}
```

- `args` は node.exe に渡す、絶対パスの JS エントリーポイント 1 つです（公式の拡張子なし `bin/codebuddy` も使用可能）。この CLI バージョンのパーサーはワイルドカードに対応していないため、ゲートウェイが一覧に基づいて約 60 個の組み込みツールを個別に無効化し、ツールを持たない専用 Agent を作成します
- リクエスト後の初期化イベントでツールがまだ報告される場合、そのリクエストを拒否します。パラメーター指定だけに依存せず、実行時の報告を確認します
- hooks 無効、空の MCP 設定、隔離された一時ディレクトリ、セッション保存なし
- 利用枠：公式 CLI でアカウント残高を照会する方法は未確認のため、`unknown` のままです。`/cost` やモデルのポイント倍率はアカウント残高の代わりにはなりません。`/admin/quota` で手動登録できます

### antigravity

ローカルの公式 agy CLI（Google のログイン情報は公式 CLI 内にキャッシュされ、ゲートウェイは認証情報にアクセスしません）。1.3.1–1.3.3 を受け付けます。

```json
{
  "id": "antigravity",
  "type": "antigravity",
  "models": ["gemini-3.8-flash-low"],
  "command": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
  "enabled": false,
  "billingVerified": false
}
```

- リクエストごとに固有名のツールなし Agent（tools/MCP/skills/plugins はすべて空）と隔離された作業ディレクトリを作成します。子プロセスから商用 API の認証情報用環境変数を除去し、キャッシュ済みアカウントを使用します
- 起動前に `~/.gemini` profile を監査します。グローバル指示ファイル、グローバル MCP・プラグイン・ルールは**存在するだけで拒否**します。グローバル hooks は、運用者が `approvedHooksSha256` で現在の設定の SHA-256 ダイジェストを承認する必要があります。設定が変われば直ちに再び拒否します。ゲートウェイはユーザーのグローバル設定を変更しません
- 利用枠：公式 CLI の読み取り専用 `/usage` JSON（1.3.3 が必要）。Gemini と第三者の Claude/GPT モデルグループについて、5 時間・週次の percent ウィンドウをそれぞれ読み取ります。モデルへの追加呼び出しは行いません

### codex

相互に排他的な 3 つのモード：

| `mode` | 機能 | 説明 |
| --- | --- | --- |
| `app-server`（デフォルト） | 利用枠の読み取りのみ | 公式 RPC で percent ウィンドウを取得。**推論は利用不可**（すべてのツールを無効化した設定を検証できるまでは有効にしない） |
| `responses` | 推論 | ChatGPT SIWC アクセストークン（`tokenEnv`）、構造化された複数ターン + system。`sk-` API key は拒否。トークンは運用者が取得・更新する必要があり、自動更新はなし |
| `exec` | 推論 | 公式 CLI **0.157.1 に固定**。ChatGPT アカウントでログイン、読み取り専用サンドボックス、ツール・スキル・プラグイン・メモリーなどを個別に無効化。単一ターン |

```json
{
  "id": "codex",
  "type": "codex",
  "mode": "exec",
  "models": ["gpt-6-sol"],
  "command": "codex",
  "enabled": false,
  "billingVerified": false
}
```

## 運用

管理 API（すべて Admin Key を使用）：

| エンドポイント | 説明 |
| --- | --- |
| `GET /admin/status` | プロバイダーの対応機能、利用枠スナップショット、クールダウン記録、アクティブなリース |
| `POST /admin/quota` | 利用枠の手動登録（`pool` フィールドで共有利用枠プールを作成可能。`resetAt` は Unix ミリ秒） |
| `POST /admin/quota/refresh` | 読み取り専用の利用枠取得。`provider` と `model` を指定可能。デフォルトでは有効な各 Provider の最初のモデルを照会。モデルを呼び出さず、手動登録の利用枠を上書きしない |
| `POST /admin/unblock` | 指定 provider/model のスナップショットとクールダウンを消去して再取得 |

障害時の自動動作：利用枠の枯渇 → 公式のリセット時刻までクールダウン（不明なら 60 秒）。レート制限 → `Retry-After` に従ってクールダウン。認証失敗 → プロバイダー全体を 5 分間ブロック。クールダウンの期限後は、復旧確認用のリクエストを 1 件だけ許可します。プロセスのクラッシュで残った同時実行リースは、有効期限に従って自動的に削除します。

利用枠の読み取りと更新：

```powershell
npm run quota
node --env-file=.env.local scripts/quota.ts --provider ark
node --env-file=.env.local scripts/quota.ts --provider antigravity --model gemini-3.8-flash-low
```

結果の `quota` は今回の照会結果、`effectiveQuota` はルーティングで実際に使用するキャッシュ、`saved` は今回、未知ではない新しいスナップショットを保存したかどうかを示します。手動登録が優先され、公式の更新では上書きされません。公式スナップショットのデフォルトのキャッシュ期間は 60 秒です。通常のリクエストでは、利用枠が欠落・未知・期限切れの場合に更新を試み、成功した呼び出しの後にも短時間の更新を試みます。Claude は既存のリクエストが生成したイベントを受動的に読み取るだけで、更新コマンドが利用枠照会のために新たな会話を送ることはありません。同じ公式観測の有効期間が、読み取りによって延長されることもありません。

ヘルスチェックと利用枠照会には独立した時間制限があります。ルーティング時のデフォルト上限はそれぞれ 3 秒と 10 秒、呼び出し後のベストエフォートの更新は最大 1 秒です。処理全体には引き続きリクエストのタイムアウトが適用されます。照会に失敗しても健全な Provider はブロックせず、未知であることの取得元と理由を返します。削除済み Provider の過去の利用枠やクールダウン記録が SQLite に残る場合がありますが、ルーティングには参加せず、`/v1/models` にも表示されません。

## 開発とテスト

```powershell
node --test tests/*.test.ts     # 全テスト：ローカル HTTP/SQLite/子プロセス fixtures。実際のアカウントにはアクセスしない
npm run typecheck               # 事前に npm install で開発依存をインストール
npm run format:src
npm run format:check
```

通常の互換 API Provider の追加は設定だけで行え、adapter の実装は不要です。他のプロトコルを接続する場合は `src/types.ts` の `Provider` インターフェースを実装し、`src/adapters/index.ts` に登録します。HTTP 層とスケジューラーの拡張が必要なのは、既存のメッセージやイベントの契約を超える機能だけです。詳しい契約は [src/adapters/README.md](src/adapters/README.md)、コードの解説は `docs/code-walkthrough.md` を参照してください。

## 現在の制限

- **API の範囲**：`/v1/chat/completions` と `/v1/models` を提供します。クライアント向けの `/v1/responses`、Embeddings、独立した画像生成、音声文字起こし、ファイル管理のエンドポイントはありません。Codex の `mode: responses` は内部のサブスクリプション呼び出し経路であり、クライアントへの Responses API の公開を意味しません。
- **CLI の機能**：Claude、CodeBuddy、Antigravity、Codex exec は、user メッセージ 1 件と任意の先頭 system 指示によるテキストリクエストのみ対応します。ツール、マルチモーダル、生成パラメーターには対応しません。明示的な CLI リクエストは `unsupported` を返し、`auto` はリクエストの対応機能で絞り込みます。Codex 内部の Responses は複数ターンのテキストに対応しますが、これらの拡張フィールドには対応しません。
- **互換 API の対応範囲**：tools、構造化出力、マルチモーダルメッセージ、推論パラメーター、レスポンス拡張の転送は実装済みです。実際の利用可否は上流モデルによって決まります。ゲートウェイはツールを実行せず、メディアをダウンロードせず、未対応モデルを対応モデルに変換することもありません。
- **ルーティングの範囲**：各 Provider では `models[0]` だけを使用し、同じ Provider 内で他のモデルを自動選択しません。明示的なエイリアスでは Provider 間のフォールバックを行いません。会話の固定ルーティングはなく、後続の `auto` リクエストでモデルが変わる場合があります。パラメーターエラーや未対応エラーではフォールバックせず、ストリーミング出力開始後も切り替えません。
- **利用枠はリアルタイムの正確な残高ではない**：公式スナップショットにはキャッシュと取得の遅延があり、percent ウィンドウは残り token 数やリクエスト数とは異なります。Ark には追加のコントロールプレーンへのログインが必要で、Claude は実際のレスポンスイベントの観測が必要です。CodeBuddy と Agnes では公式残高の取得が未実装です。利用枠が未知でもルーティングに参加できます。同時実行の token 予算は保守的な推定で、実際の消費量は有効な上流 usage に基づいて精算します。USD key 使用量はアカウントのウォレット残高とは異なります。
- **容量と設定の反映**：単一リクエスト本文は最大 1 MiB、レスポンス合計は最大 16 MiB、単一 SSE frame は最大 1 MiB です。`maxConcurrency` はローカルゲートウェイ内のその Provider へのリクエスト上限であり、上流の利用枠やレート制限を増やすものではありません。設定ファイルや環境変数ファイルの変更後は再起動が必要です。
- **ローカルサービスの範囲**：ループバックアドレスのみで待ち受け、マルチテナント、ユーザー分離、組み込みの会話ストレージはありません。`available`/`doctor` は接続、利用枠、モデルの利用権限、課金を保証しません。`billingVerified` は運用者による宣言です。CLI の POSIX 環境へのデプロイと、SIGTERM に抵抗する子プロセスのクリーンアップは未検証です。
- **ログの範囲**：ゲートウェイの通常の状態・エラー出力には prompt、トークン、キー、上流の生のエラー本文を記録しません。クライアントによる回答の保存、独立した CLI ログ、`.tools` の手動検証レポートには、それぞれ独自のデータ保存範囲があります。
