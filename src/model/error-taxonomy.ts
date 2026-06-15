// ENVELOPE-AWARE ERROR CLASSIFICATION.
//
// The hardest-won lesson from the June-2026 provider research: you CANNOT
// classify a model failure by HTTP status alone. Bedrock returns 400 for
// throttling; Vertex and MiniMax return 200 with the failure in the body;
// OpenAI 429 splits into retryable rate-limit vs non-retryable quota by `code`,
// but Azure collapses both to "429". So this classifier branches on the ERROR
// ENVELOPE shape first (each provider family has a distinguishable one), then on
// the symbolic name/code, then on message substrings — in that order.
//
// It produces the same { kind, scope } the cooldown/failover loop already
// consumes (src/model/cooldown.ts), plus a finer `class` for honest UX. Pure.
//
// Envelope shapes detected:
//   OpenAI-wire    {error:{message,type,code}}        (openai, azure, deepseek, groq, …)
//   Anthropic      {type:"error",error:{type,message}} (anthropic, bedrock-mantle)
//   AWS exception  {__type|name:"ThrottlingException"} (bedrock InvokeModel/Converse)
//   Google RPC     {error:{code,status:"RESOURCE_EXHAUSTED"}} (vertex, gemini)
//   MiniMax        {base_resp:{status_code,status_msg}} (in a 200!)
//   FastAPI        {detail:...}                         (nebius, deepinfra-native)
//   Baseten        {error:"<bare string>"}              (baseten)

import type { FailureKind, CooldownScope } from "./cooldown.ts";

export type ErrorClass =
  | "rate-limit" // transient throughput cap — recovers on its own
  | "quota" // billing/credit/balance drained — account dead until topped up
  | "auth" // invalid/expired credentials — account dead until re-login
  | "content-filter" // blocked by safety policy — NEVER a failover trigger
  | "context-length" // prompt too long — compact, don't hop
  | "model-gone" // decommissioned / not-found — don't retry this id
  | "bad-request" // malformed/unsupported param — fix the request, don't hop
  | "server" // 5xx / overloaded — retryable
  | "unknown";

export interface Classified {
  class: ErrorClass;
  kind: FailureKind;
  scope: CooldownScope;
}

const KIND: Record<ErrorClass, FailureKind> = {
  "rate-limit": "exhausted",
  quota: "exhausted",
  auth: "auth",
  server: "exhausted",
  "content-filter": "other",
  "context-length": "other",
  "model-gone": "other",
  "bad-request": "other",
  unknown: "other",
};

// Scope: a drained wallet (quota/auth) kills every model on the account; a rate
// cap or per-model failure is scoped to the (account, model) pair.
const SCOPE: Record<ErrorClass, CooldownScope> = {
  quota: "account",
  auth: "account",
  "rate-limit": "model",
  server: "model",
  "content-filter": "model",
  "context-length": "model",
  "model-gone": "model",
  "bad-request": "model",
  unknown: "model",
};

function classify(klass: ErrorClass): Classified {
  return { class: klass, kind: KIND[klass], scope: SCOPE[klass] };
}

/** Pull a few signals off whatever the SDK threw (object or string). */
function extract(err: unknown): { http?: number; body: any; text: string } {
  if (err == null) return { body: {}, text: "" };
  if (typeof err === "string") return { body: {}, text: err };
  const e = err as any;
  const http = e.statusCode ?? e.status ?? e.response?.status ?? e?.data?.error?.code;
  // The parsed JSON body the provider returned, wherever the SDK stashed it.
  const body = e.responseBody ?? e.data ?? e.body ?? e.error ?? e;
  const text = [e.message, e.responseBody, typeof body === "string" ? body : JSON.stringify(body ?? {})]
    .filter(Boolean)
    .join(" ");
  return { http: typeof http === "number" ? http : undefined, body, text };
}

/**
 * Classify a provider failure. Pass the raw error the SDK threw (preferred — it
 * carries status + body) or a message string. Branches: envelope → name/code →
 * substring.
 */
export function classifyError(err: unknown): Classified {
  const { http, body, text } = extract(err);
  const m = text.toLowerCase();

  // --- MiniMax: base_resp inside a 200 -----------------------------------
  const baseResp = (body && (body.base_resp ?? body?.data?.base_resp)) as { status_code?: number } | undefined;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    const c = baseResp.status_code;
    if (c === 1004 || c === 2049) return classify("auth");
    if (c === 1008) return classify("quota");
    if (c === 1002 || c === 1039 || c === 1041 || c === 2056) return classify("rate-limit");
    if (c === 1026 || c === 1027) return classify("content-filter");
    if (c === 2013) return classify("bad-request");
    return classify("server");
  }

  // --- AWS exception envelope (Bedrock): name carries the truth, 400≠bad --
  const awsName: string | undefined = (body && (body.__type || body.name || body.Code)) || (err as any)?.name;
  if (awsName && /Exception$|^Throttling|^AccessDenied|^Validation|^ServiceQuota|^ResourceNotFound|^ExpiredToken|^UnrecognizedClient/.test(awsName)) {
    if (/Throttling/.test(awsName)) return classify("rate-limit");
    if (/ServiceQuotaExceeded/.test(awsName)) return classify("quota");
    if (/ExpiredToken|UnrecognizedClient|AccessDenied|NotAuthorized|OptInRequired/.test(awsName)) return classify("auth");
    if (/ResourceNotFound/.test(awsName)) return classify("model-gone");
    if (/ModelTimeout|ModelNotReady|ServiceUnavailable|InternalFailure/.test(awsName)) return classify("server");
    if (/Validation/.test(awsName)) {
      // The on-demand-throughput message means "use the inference-profile id".
      return classify(/on-demand throughput|inference profile/.test(m) ? "model-gone" : "bad-request");
    }
  }

  // --- Google RPC status enum (Vertex/Gemini) ----------------------------
  const gStatus: string | undefined = body?.error?.status ?? body?.status;
  if (gStatus && /^[A-Z_]+$/.test(gStatus)) {
    if (gStatus === "RESOURCE_EXHAUSTED") return classify("rate-limit");
    if (gStatus === "PERMISSION_DENIED" || gStatus === "UNAUTHENTICATED") return classify("auth");
    if (gStatus === "NOT_FOUND") return classify("model-gone");
    if (gStatus === "INVALID_ARGUMENT" || gStatus === "FAILED_PRECONDITION") return classify("bad-request");
    if (gStatus === "UNAVAILABLE" || gStatus === "INTERNAL") return classify("server");
  }

  // --- Content filter (Azure/OpenAI/Anthropic/Gemini) — never failover ----
  if (
    /content[_ ]?filter|responsibleai|content management policy|safety|jailbreak|content_policy|prohibited_content|blocklist/.test(m) &&
    !/rate|quota|limit/.test(m)
  ) return classify("content-filter");

  // --- OpenAI-wire `code`/`type` (openai, azure, deepseek, groq, mistral) -
  const code: string | undefined = body?.error?.code ?? body?.code;
  const type: string | undefined = body?.error?.type ?? body?.type;
  if (code === "insufficient_quota" || type === "insufficient_quota") return classify("quota");
  if (code === "rate_limit_exceeded") return classify("rate-limit");
  if (code === "context_length_exceeded") return classify("context-length");
  if (code === "model_not_found" || code === "model_decommissioned" || code === "model_deprecated") return classify("model-gone");
  if (code === "invalid_api_key" || type === "authentication_error") return classify("auth");
  if (code === "unsupported_parameter" || code === "unsupported_value") return classify("bad-request");

  // --- Substring fallback (covers the long tail + Azure's ambiguous 429) --
  if (/operation (?:is )?unsupported|does not work with the specified model|operationnotsupported/.test(m)) return classify("bad-request");
  if (/maximum context length|context (?:window |length )?exceeded|too large for model|reduce the length/.test(m)) return classify("context-length");
  if (/has been decommissioned|model_deprecated|no longer available|not found|does not exist/.test(m)) return classify("model-gone");
  if (/insufficient[_ ](?:quota|balance|credits?)|out of credit|credit balance|payment required|\b402\b|exceeded your current quota|balance.?not.?enough|run out of balance/.test(m)) return classify("quota");
  if (/\b429\b|\b529\b|rate.?limit|too many requests|over(?:loaded|capacity)|throttl|resource.?exhausted|usage.?limit|engine_overloaded/.test(m)) return classify("rate-limit");
  if (/\b401\b|\b403\b|invalid[ _-]?(?:api[ _-]?key|key|credential|token)|invalid subscription key|unauthorized|authentication[ _-]?(?:error|failed)|token (?:has )?expired|expired (?:key|token|credentials?)|not logged in|permission denied/.test(m)) return classify("auth");
  if (/\b5\d\d\b|server error|internal error|service unavailable|try again/.test(m)) return classify("server");
  if (/invalid request|extra inputs are not permitted|unsupported|bad request|\b400\b|\b422\b/.test(m)) return classify("bad-request");

  // Honor a bare HTTP status if that's all we have.
  if (http === 429) return classify("rate-limit");
  if (http === 401 || http === 403) return classify("auth");
  if (http === 404) return classify("model-gone");
  if (http && http >= 500) return classify("server");

  return classify("unknown");
}
