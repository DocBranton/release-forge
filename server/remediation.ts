// Offline remediation guidance: rule-specific advice where we have it, category advice otherwise.
// Written so a model-backed Wingman can replace or extend it later without changing callers.
import type { Finding } from "../shared/types.ts";

export interface Guidance { summary: string; steps: string[]; verify: string; references: string[] }

const PATTERNS: { test: RegExp; g: Guidance }[] = [
  {
    test: /sql[-_ ]?injection|sqli|tainted-sql|raw-?query|knex-raw|sequelize-raw/i,
    g: {
      summary: "Untrusted input reaches a SQL statement.",
      steps: ["Replace string-built SQL with parameterized queries ($1, $2 … or the driver's placeholders).", "Keep table and column names in constants; never take them from input.", "Validate the input's type and length at the route boundary."],
      verify: "Rerun Semgrep; the rule should no longer match. Add a test that passes a quote character and checks the query still behaves.",
      references: ["OWASP A03:2021 Injection", "CWE-89"],
    },
  },
  {
    test: /xss|innerhtml|dangerouslysetinnerhtml|insecure-document-method|html-in-template/i,
    g: {
      summary: "Data may be written into the page as HTML.",
      steps: ["Render text with textContent (or React's normal JSX), not innerHTML.", "If HTML is required, sanitize it with a maintained sanitizer and an allowlist.", "Set a Content-Security-Policy that disallows inline script."],
      verify: "Rerun Semgrep. If the value is numeric or constant, mark the finding a false positive with that explanation.",
      references: ["OWASP A03:2021 Injection", "CWE-79"],
    },
  },
  {
    test: /path[-_ ]?traversal|non-literal-fs|directory-traversal/i,
    g: {
      summary: "A file path may be built from user input.",
      steps: ["Resolve the path and check it stays inside the intended base directory.", "Prefer IDs that map to stored paths over taking file names from requests.", "Reject '..', absolute paths and encoded separators."],
      verify: "Add a test that requests ../ and %2e%2e%2f paths and expects a 400.",
      references: ["OWASP A01:2021 Broken Access Control", "CWE-22"],
    },
  },
  {
    test: /eval|function-constructor|code-injection|new-function|vm-runin/i,
    g: {
      summary: "Code may be built from strings at runtime.",
      steps: ["Remove eval / new Function, or replace them with a parser for the specific format.", "If generated code must run, isolate it in a separate process or container with no credentials and no network."],
      verify: "Rerun Semgrep and the sandbox tests.",
      references: ["OWASP A03:2021 Injection", "CWE-95"],
    },
  },
  {
    test: /ssrf|request-forgery|tainted-url/i,
    g: {
      summary: "The server may fetch a URL that a user controls.",
      steps: ["Fetch only hosts on an allowlist kept in server configuration.", "Resolve and block private, link-local and metadata addresses.", "Don't forward the user's or the app's credentials to fetched URLs."],
      verify: "Add a test that asks for http://169.254.169.254/ and expects a refusal.",
      references: ["OWASP A10:2021 SSRF", "CWE-918"],
    },
  },
  {
    test: /hardcoded|hard-coded|secret|password|api[-_ ]?key|token|aws-access/i,
    g: {
      summary: "A credential may be written in the code.",
      steps: ["Rotate the credential first; assume it is compromised.", "Move it to a Databricks secret and read it through an app resource (valueFrom).", "Remove it from git history (git filter-repo) and force-push only with your team's agreement."],
      verify: "Rerun Gitleaks over the full history; confirm the old credential no longer works.",
      references: ["OWASP A07:2021 Identification and Authentication Failures", "CWE-798"],
    },
  },
  {
    test: /^CKV_|checkov/i,
    g: {
      summary: "An infrastructure or pipeline configuration fails a Checkov policy.",
      steps: ["Read the check's guideline and change the configuration to comply.", "If the check does not apply, add a skip with a written reason in .checkov.yaml so reviewers can see it."],
      verify: "Rerun Checkov; the check should pass or show as a justified skip.",
      references: ["Checkov policy index"],
    },
  },
];

const BY_CATEGORY: Record<Finding["category"], Guidance> = {
  sbom: {
    summary: "A dependency has a published vulnerability.",
    steps: ["Upgrade the package to a fixed version; if it comes in through another package, add an npm override.", "If nothing in the app loads the package, remove the dependency instead.", "Commit the updated package-lock.json."],
    verify: "Run npm audit --omit=dev; the advisory should be gone.",
    references: ["OWASP A06:2021 Vulnerable and Outdated Components"],
  },
  secrets: {
    summary: "Gitleaks found something that looks like a credential.",
    steps: ["Check whether it is a real credential or a test value / checksum.", "If real: rotate it, move it to a Databricks secret, and purge it from history.", "If not: have the ISSM mark it a false positive with the reason, and add an allowlist entry for the path."],
    verify: "Rerun Gitleaks over the full history.",
    references: ["CWE-798"],
  },
  malware: {
    summary: "ClamAV matched a malware signature.",
    steps: ["Do not deploy. Remove the file from the repository and its history.", "Find how it was introduced (commit author, dependency, vendored binary).", "Tell the ISSM; if the match is a known test file (EICAR), document it."],
    verify: "Rerun ClamAV with fresh signatures.",
    references: ["NIST 800-53 SI-3"],
  },
  bundle: {
    summary: "The Databricks Asset Bundle does not validate cleanly.",
    steps: ["Run databricks bundle validate locally against the target workspace.", "Fix the reported keys, resource references or variables."],
    verify: "databricks bundle validate exits 0 in the pipeline.",
    references: ["Databricks Asset Bundles documentation"],
  },
  iac: {
    summary: "An infrastructure or pipeline configuration fails a policy check.",
    steps: ["Change the configuration to comply with the check, or record a justified skip in .checkov.yaml."],
    verify: "Rerun Checkov.",
    references: ["Checkov policy index"],
  },
  sast: {
    summary: "Static analysis flagged a code pattern that is often unsafe.",
    steps: ["Read the flagged line and the rule's description.", "If input can reach it, fix the code; if not, mark it a false positive with the reason."],
    verify: "Rerun Semgrep.",
    references: ["Semgrep rule registry"],
  },
  owasp: {
    summary: "Code matches an OWASP Top 10 rule.",
    steps: ["Read the flagged line and the rule's description.", "Fix the pattern, or mark it a false positive with the reason."],
    verify: "Rerun Semgrep.",
    references: ["OWASP Top 10 (2021)"],
  },
};

export function guidanceFor(f: Pick<Finding, "category" | "rule" | "title" | "tool" | "recommendation">): Guidance {
  const hay = `${f.rule} ${f.title}`;
  const hit = f.category === "sbom" || f.category === "malware" || f.category === "bundle" ? null : PATTERNS.find((p) => p.test.test(hay));
  const base = hit?.g ?? BY_CATEGORY[f.category];
  // The scanner's own recommendation is the most specific advice we have; lead with it.
  const steps = f.recommendation && !base.steps.includes(f.recommendation) ? [f.recommendation, ...base.steps] : base.steps;
  return { ...base, steps };
}
