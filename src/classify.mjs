/**
 * Rules-based job relevance classifier (relevance layer / f-113).
 *
 * Maps a job title to { family, is_target, seniority, confidence }.
 *
 * HIGH PRECISION by design: it only emits a confident family when a strong,
 * unambiguous signal matches. Everything else returns confidence:'low', which
 * the hybrid LLM pass (scripts/backfill-classification.mjs --llm) adjudicates.
 * Precision over recall keeps the free pass from mislabelling — e.g. a bare
 * "manager" must NOT become executive_leadership; "restaurant manager" must be
 * service, not exec.
 *
 * "Target" = a role our customers (tech/IT professionals, knowledge-workers,
 * senior/executive leadership, and students/interns in those fields) would pay
 * to be matched to. NOT manual/service/retail/hospitality/skilled-trade/
 * clinical roles. Classification is by the ROLE, never the employer's industry:
 * a "Data Scientist" at a restaurant chain is target; a "Dishwasher" at a tech
 * company is not.
 *
 * Regex note: groups intentionally have NO trailing \b so prefix alternatives
 * (e.g. "data scien") match "science"/"scientist". The leading \b still guards
 * against mid-word false matches.
 */

// Non-target families. Checked FIRST so concrete industry/role context
// (restaurant, retail, dental, automotive…) overrides the generic role words
// (manager/associate/specialist/technician) that also appear in target titles.
const NON_TARGET = [
  ['service_hospitality', /\b(dishwasher|busser|barista|bartender|bar ?back|waiter|waitress|wait\s?staff|\bserver\b|host(ess)?|line cook|prep cook|\bcook\b|\bchef\b|kitchen|catering|restaurant|food service|food & beverage|hospitality|housekeep|room attendant|valet|concierge|crew member|fast food|drive.?thru)/i],
  ['retail', /\b(cashier|sales associate|retail|store associate|store manager|shop assistant|merchandiser|stock(er| associate| clerk)|bagger|checkout|vendeur|vendeuse|sales assistant|key ?holder|department manager, store)/i],
  ['clinical_healthcare', /\b(care assistant|caregiver|carer|\bcna\b|nursing assistant|home health|dental (assistant|nurse|hygienist)|dentist|chirurgien|medical assistant|phlebotom|physical therap|occupational therap|veterinar|\bvet\b|registered nurse|\brn\b|\blpn\b|\bcma\b|patient care|pharmacy technician|midwife|paramedic|\bemt\b|behavio.?r(al)? (health )?technician|\brbt\b|\baba\b (therap|provider)|direct support professional|optician|esthetician|massage therap)/i],
  ['skilled_trades', /\b(electrician|plumber|\bhvac\b|automotive|\bmechanic\b|welder|machinist|carpenter|painter|roofer|locksmith|appliance (repair|technician)|field service (technician|tech)|maintenance (technician|worker)|installer|lineman|millwright|fabricator|tire technician|diesel)/i],
  ['manual_labor', /\b(warehouse|forklift|laborer|labourer|order picker|\bpicker\b|\bpacker\b|loader|mover|\bdriver\b|delivery|courier|chauffeur|landscap|groundskeep|cleaner|cleaning|janitor|custodian|sanitation|production (worker|operative|associate)|assembler|machine operator|general labor|farm|harvest)/i],
  ['security_guard', /\b(security (guard|officer)|loss prevention|patrol officer|door supervisor|bouncer|gate ?keeper)/i],
  ['education_childcare', /\b(childcare|child care|\bnanny\b|babysitt|preschool|daycare|teaching assistant|paraprofessional|substitute teacher|early years|after.?school)/i],
];

// Target families (roles our customers want matched).
const TARGET = [
  ['software_engineering', /\b(software (engineer|developer)|développeur|\bdeveloper\b|programmer|\bsde\b|\bswe\b|full.?stack|back.?end|front.?end|web developer|mobile (developer|engineer)|\bios\b|android (developer|engineer)|embedded (engineer|software)|firmware|game (developer|engineer)|qa (engineer|automation)|\bsdet\b|automation engineer|engineering (manager|lead)|staff engineer|principal engineer|founding engineer|product engineer|software architect)/i],
  ['data_ai', /\b(data scien|data engineer|machine learning|\bml\b ?(engineer|scientist|ops)|\bai\b ?(engineer|scientist|researcher)|mlops|deep learning|\bnlp\b|computer vision|research scientist|applied scientist|analytics engineer|business intelligence|\bbi\b (developer|analyst|engineer)|data analyst|quantitative (analyst|research)|decision scien)/i],
  ['it_infrastructure', /\b(devops|\bsre\b|site reliability|platform engineer|cloud (engineer|architect|infrastructure)|infrastructure engineer|systems? engineer|system administrator|sysadmin|network (engineer|administrator)|database administrator|\bdba\b|it (support|administrator|manager|specialist)|help ?desk|service desk|desktop support|solutions architect|technical support engineer)/i],
  ['security', /\b(security engineer|cyber.?security|information security|infosec|appsec|application security|soc analyst|penetration test|pentest|security (analyst|architect|operations)|threat (intelligence|hunting)|grc analyst)/i],
  ['product', /\b(product manager|product owner|technical program manager|\btpm\b|group product manager|head of product|product operations)/i],
  ['design', /\b(\bux\b|\bui\b|product designer|ux researcher|ux\/ui|interaction designer|visual designer|design (lead|manager|director)|graphic designer|web designer|design systems|motion designer|brand designer)/i],
  ['finance', /\b(financial analyst|fp&a|\bcontroller\b|accountant|accounting (manager|specialist)|investment (analyst|banking|associate)|equity research|portfolio manager|actuar|treasury (analyst|manager)|tax (manager|analyst|accountant)|auditor|financial (controller|planning))/i],
  ['sales', /\b(account executive|\bae\b|sales (engineer|representative|rep|manager|director|specialist)|business development (manager|representative|rep)|\bbdr\b|\bsdr\b|account manager|solutions (engineer|consultant|architect)|sales development|enterprise sales|inside sales|partnerships? manager|customer success manager)/i],
  ['marketing', /\b(marketing (manager|specialist|director|coordinator|lead)|growth (manager|marketer|lead)|\bseo\b|content (marketer|strategist|manager)|brand (manager|strategist)|demand generation|product marketing|communications manager|public relations|social media (manager|specialist)|digital marketing|performance marketing|lifecycle marketing)/i],
  ['consulting', /\b(management consult|strategy (consultant|manager|associate)|\bconsultant\b, (technology|management|strategy)|associate consultant|engagement manager|implementation consultant)/i],
  ['legal', /\b(attorney|lawyer|legal counsel|general counsel|corporate counsel|\bparalegal\b|compliance (officer|manager|analyst))/i],
  ['hr_recruiting', /\b(recruiter|talent acquisition|technical recruiter|people (operations|partner)|\bhr\b (manager|business partner|generalist)|human resources (manager|business partner))/i],
  ['executive_leadership', /\b(chief (executive|technology|financial|operating|product|marketing|information|revenue|data|people) officer|\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcpo\b|\bcmo\b|\bcio\b|\bciso\b|\bvp\b|vice president|\bsvp\b|\bevp\b|head of (engineering|product|data|design|marketing|sales|growth|operations|finance|revenue|security))/i],
];

const SENIORITY = [
  ['intern', /\b(intern|internship|co.?op|trainee|apprentice|working student|werkstudent|graduate (program|scheme|analyst)|new grad|early career|placement student)/i],
  ['exec', /\b(chief|\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcpo\b|\bcmo\b|\bcio\b|\bciso\b|president|\bvp\b|vice president|\bsvp\b|\bevp\b|\bpartner\b)/i],
  ['director', /\b(director|head of)/i],
  ['manager', /\b(manager|\blead\b|principal|staff)/i],
  ['senior', /\b(senior|\bsr\.?\b|\biii\b|\biv\b)/i],
  ['junior', /\b(junior|\bjr\.?\b|entry.level|\bi\b|\bii\b|associate)/i],
];

function seniorityOf(title) {
  for (const [level, re] of SENIORITY) if (re.test(title)) return level;
  return null;
}

/**
 * Classify a single title.
 * @returns {{family: string|null, is_target: boolean|null, seniority: string|null, confidence: 'high'|'low'}}
 *   confidence:'low' (family/is_target null) means "ambiguous — send to the LLM pass".
 */
export function classifyTitle(rawTitle) {
  const title = (rawTitle || '').trim();
  if (!title) return { family: null, is_target: null, seniority: null, confidence: 'low' };
  for (const [family, re] of NON_TARGET) {
    if (re.test(title)) return { family, is_target: false, seniority: seniorityOf(title), confidence: 'high' };
  }
  for (const [family, re] of TARGET) {
    if (re.test(title)) return { family, is_target: true, seniority: seniorityOf(title), confidence: 'high' };
  }
  return { family: null, is_target: null, seniority: seniorityOf(title), confidence: 'low' };
}
