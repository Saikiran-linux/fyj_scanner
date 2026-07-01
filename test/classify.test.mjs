/**
 * Tests for the f-121 SmartRecruiters structured-signal resolution in
 * classifyJob(). Fixtures are REAL postings pulled live from the SR public API
 * on 2026-06-12 (titles + their function/experienceLevel enums), chosen to pin
 * the precedence + guard behaviour:
 *
 *   1. Title wins over `function` (both directions).
 *   2. A blue-collar `function` only flips title-NULL rows.
 *   3. ...and only when the title has no knowledge-worker token — so a Project
 *      Manager / BI Analyst / PCB Engineer in a blue-collar org bucket is NOT
 *      hidden (the bug this guard exists to prevent).
 *   4. `experienceLevel` fills seniority where the title is silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJob, classifyTitle } from '../src/classify.mjs';

test('non-SR job behaves like title rules (no structured signals)', () => {
  const c = classifyJob({ title: 'Software Engineer' });
  assert.equal(c.is_target, true);
  assert.equal(c.family, 'software_engineering');
  assert.equal(c.classified_by, 'rules');
});

test('title TARGET wins over a blue-collar function (not flipped)', () => {
  // Live: "Local Account Manager" under function=Supply Chain → sales (target).
  const c = classifyJob({ title: 'Local Account Manager', srFunction: 'Supply Chain' });
  assert.equal(c.is_target, true);
  assert.equal(c.family, 'sales');
  assert.equal(c.classified_by, 'rules');
});

test('title TARGET wins even when function=Manufacturing', () => {
  // Live: "Senior Embedded Software Developer (Audio_PA)" under function=Manufacturing.
  const c = classifyJob({ title: 'Senior Embedded Software Developer (Audio_PA)', srFunction: 'Manufacturing' });
  assert.equal(c.is_target, true);
  assert.equal(c.family, 'software_engineering');
});

test('BI Analyst stays target regardless of function=Production (user-reported case)', () => {
  const c = classifyJob({ title: 'BI Analyst', srFunction: 'Production' });
  assert.equal(c.is_target, true);
  assert.equal(c.family, 'data_ai');
});

test('Project Manager in Production is NOT hidden — pro token guards the flip (user-reported case)', () => {
  // Title rules can't resolve a bare "Project Manager" → null. function=Production
  // would naively flip it to false, but the "manager" token blocks that, leaving
  // it ambiguous for the LLM pass (is_target=null surfaces, never hidden).
  const c = classifyJob({ title: 'Project Manager', srFunction: 'Production' });
  assert.equal(c.is_target, null);
  assert.equal(c.confidence, 'low');
  assert.equal(c.classified_by, 'low');
});

test('PCB Layout Engineer in Manufacturing is protected by the engineer token', () => {
  const c = classifyJob({ title: 'High-Speed Digital PCB Layout Engineer', srFunction: 'Manufacturing' });
  assert.equal(c.is_target, null);
  assert.equal(c.classified_by, 'low');
});

test('token-less title in a blue-collar function IS flipped to non-target', () => {
  // "Line Operator" isn't caught by the title rules (null) and carries no
  // knowledge-worker token, so function=Production is a safe negative prior.
  const c = classifyJob({ title: 'Line Operator', srFunction: 'Production' });
  assert.equal(c.is_target, false);
  assert.equal(c.family, 'manual_labor');
  assert.equal(c.classified_by, 'sr_function');
  assert.equal(c.confidence, 'high');
});

test('function family mapping: Health Care Provider → clinical_healthcare', () => {
  const c = classifyJob({ title: 'Patient Services Representative', srFunction: 'Health Care Provider' });
  assert.equal(c.is_target, false);
  assert.equal(c.family, 'clinical_healthcare');
});

test('enum label punctuation variants normalise (en-dash vs hyphen)', () => {
  const hyphen = classifyJob({ title: 'Shift Worker', srFunction: 'Restaurant - Food Service' });
  const endash = classifyJob({ title: 'Shift Worker', srFunction: 'Restaurant – Food Service' });
  assert.equal(hyphen.is_target, false);
  assert.equal(hyphen.family, 'service_hospitality');
  assert.equal(endash.is_target, false);
});

test('non-blue-collar function (Customer Service) never flips', () => {
  const c = classifyJob({ title: 'Account Coordinator', srFunction: 'Customer Service' });
  assert.equal(c.is_target, null);
  assert.equal(c.classified_by, 'low');
});

test('title NON-TARGET is reported via rules even inside a blue function', () => {
  const c = classifyJob({ title: 'Forklift Operator', srFunction: 'Supply Chain' });
  assert.equal(c.is_target, false);
  assert.equal(c.family, 'manual_labor');
  assert.equal(c.classified_by, 'rules');
});

test('experienceLevel fills seniority when the title is silent', () => {
  // "Line Operator" has no seniority token, so experienceLevel supplies it.
  const c = classifyJob({ title: 'Line Operator', srFunction: 'Production', srExperienceLevel: 'Entry Level' });
  assert.equal(c.seniority, 'junior');
});

test('experienceLevel Executive → exec', () => {
  // "Software Engineer" carries no seniority token, so the fill applies.
  const c = classifyJob({ title: 'Software Engineer', srExperienceLevel: 'Executive' });
  assert.equal(c.seniority, 'exec');
});

test('experienceLevel never overrides a seniority the title already set', () => {
  // Title "Senior ..." → senior; experienceLevel must not downgrade it.
  const c = classifyJob({ title: 'Senior Data Scientist', srExperienceLevel: 'Entry Level' });
  assert.equal(c.seniority, 'senior');
});

test('experienceLevel "Not Applicable" leaves seniority untouched', () => {
  // "Welder" has no seniority token; 'Not Applicable' is unmapped → stays null.
  const c = classifyJob({ title: 'Welder', srExperienceLevel: 'Not Applicable' });
  assert.equal(c.seniority, null);
});

test('classifyTitle is unchanged (backward compatibility)', () => {
  assert.deepEqual(classifyTitle('Dishwasher'), {
    family: 'service_hospitality', is_target: false, seniority: null, confidence: 'high',
  });
});

// ── f-113 rule-gap hardening (2026-06-17) ──────────────────────────────────
// Blue-collar titles that previously fell through to null (confidence:'low')
// and leaked into the surfaced index. Sampled live from the 55% unclassified
// bucket (see feature_list.json f-113 rule_gaps_found / coverage notes).
const RULE_GAP_MISSES = [
  ['Food and Beverage Attendant', 'service_hospitality'], // 'and', not just '&'
  ['Licensed Practical Nurse', 'clinical_healthcare'],     // spelled-out, \blpn\b missed
  ['Practical Nurse', 'clinical_healthcare'],
  ['Mental Health Therapist', 'clinical_healthcare'],
  ['Diversional Therapist', 'clinical_healthcare'],
  ['Spa Therapist', 'service_hospitality'],
  ['Auto Body Repair Technician', 'skilled_trades'],
  ['Reconditioning Technician', 'skilled_trades'],
  ['Distribution Technician', 'manual_labor'],
];
for (const [title, family] of RULE_GAP_MISSES) {
  test(`rule-gap: "${title}" → ${family} (non-target)`, () => {
    const c = classifyTitle(title);
    assert.equal(c.is_target, false, `${title} should be non-target`);
    assert.equal(c.family, family);
    assert.equal(c.confidence, 'high');
  });
}

// Precision guard: the new patterns must NOT capture knowledge-worker roles.
// NON_TARGET is checked before TARGET, so a too-greedy blue-collar pattern
// would silently hide these. The 'distribution X' additions are scoped to
// technician|associate|worker, so an engineering/planning title stays out of
// manual_labor (left null → surfaced, never hidden).
test('precision: new blue-collar patterns do not hide knowledge-worker roles', () => {
  assert.equal(classifyTitle('Distribution Engineer').is_target, null);
  assert.equal(classifyTitle('Power Distribution Planner').is_target, null);
  assert.equal(classifyTitle('Reconditioning Program Manager').is_target, false); // 'reconditioning' is non-target context, by design
});
