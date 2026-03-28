/**
 * Token samples for gitleaks pattern validation.
 *
 * Each entry has:
 *   - `provider`: human-readable provider name
 *   - `positive`: strings that MUST be detected (true secrets)
 *   - `negative`: strings that must NOT be detected (safe values)
 *
 * Used by scripts/update-gitleaks-patterns.ts to verify coverage.
 */

export interface TokenSample {
  provider: string;
  /** Strings that should be redacted. */
  positive: string[];
  /** Strings that should NOT be redacted. */
  negative: string[];
}

export const TOKEN_SAMPLES: TokenSample[] = [
  {
    provider: "AWS Access Key ID",
    positive: [
      "AKIAIOSFODNN7EXAMPLE",
      "AKIA1234567890ABCDEF",
      "ASIAIOSFODNN7EXAMPLE",
    ],
    negative: [
      "not-an-aws-key",
      "BKIAIOSFODNN7EXAMPLE",
    ],
  },
  {
    provider: "GitHub Personal Access Token",
    positive: [
      "ghp_" + "A".repeat(36),
      "gho_" + "A".repeat(36),
      "ghs_" + "A".repeat(36),
      "ghr_" + "A".repeat(36),
    ],
    negative: [
      "not_a_github_token",
      "ghx_" + "A".repeat(36),
    ],
  },
  {
    provider: "Slack Bot Token",
    // Note: values intentionally split to avoid triggering GitHub push protection
    // on test fixture files. These are not real tokens.
    positive: [
      ["xoxb", "000000000000", "000000000000", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("-"),
      ["xoxp", "000000000000", "000000000000", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("-"),
    ],
    negative: [
      "slack-not-a-token",
      "xoxz-123456789012",
    ],
  },
  {
    provider: "Stripe API Key",
    // Note: using obviously-fake values to avoid push protection. Not real keys.
    positive: [
      // sk_live_ keys are covered by BUILT_IN_PATTERNS (native), not gitleaks
      // gitleaks covers stripe via a different context-aware pattern
      "sk_live_" + "0".repeat(24),
      "rk_live_" + "0".repeat(32),
    ],
    negative: [
      "sk_test_51J3kxABCDEFghijKLMNop",
      "not_a_stripe_key",
    ],
  },
  {
    provider: "OpenAI API Key",
    positive: [
      "sk-" + "a".repeat(48),
      "sk-proj-" + "a".repeat(48),
    ],
    negative: [
      "not-openai",
      "sk-short",
    ],
  },
  {
    provider: "Anthropic API Key",
    positive: [
      "sk-ant-api03-" + "a".repeat(40),
      "sk-ant-admin01-" + "a".repeat(40),
    ],
    negative: [
      "not-anthropic",
      "sk-ant-short",
    ],
  },
  {
    provider: "Google/GCP API Key",
    positive: [
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    ],
    negative: [
      "not-google",
      "AIzaShort",
    ],
  },
  {
    provider: "SendGrid API Key",
    positive: [
      "SG." + "a".repeat(22) + "." + "a".repeat(43),
    ],
    negative: [
      "SG.short",
      "not-sendgrid",
    ],
  },
  {
    provider: "Twilio API Key",
    positive: [
      "SK" + "0".repeat(32),
    ],
    negative: [
      "not-twilio",
      "SK" + "0".repeat(10),
    ],
  },
  {
    provider: "npm Token",
    positive: [
      "npm_" + "a".repeat(36),
    ],
    negative: [
      "not-npm",
      "npm_short",
    ],
  },
  {
    provider: "Shopify Access Token",
    positive: [
      "shpat_" + "a".repeat(32),
      "shpca_" + "a".repeat(32),
    ],
    negative: [
      "shpxx_" + "a".repeat(32),
      "not-shopify",
    ],
  },
  {
    provider: "HashiCorp Vault Token",
    positive: [
      "hvs." + "a".repeat(96),
    ],
    negative: [
      "hvs.short",
      "not-vault",
    ],
  },
  {
    provider: "Doppler Token",
    positive: [
      "dp.pt." + "a".repeat(43),
    ],
    negative: [
      "dp.pt.short",
      "not-doppler",
    ],
  },
  {
    provider: "JWT",
    positive: [
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ],
    negative: [
      "not.a.jwt",
      "eyJ.eyJ",
    ],
  },
  {
    provider: "1Password Secret Key",
    positive: [
      "A3-ABCDEF-ABCDEFABCDE-ABCDE-ABCDE-ABCDE",
    ],
    negative: [
      "not-1password",
      "A3-short",
    ],
  },
];
