/**
 * Terms & Conditions content.
 *
 * Kept as data rather than a template so the acceptance recorded against a
 * user can be tied to a version — section 15 promises re-acceptance when the
 * terms materially change, and that promise needs a version to hang on.
 */

export const TERMS_VERSION = '2026-08-18';
export const TERMS_UPDATED = '18 August 2026';

export const TERMS_SECTIONS = [
  {
    id: 't1',
    title: 'What SchemeConnect is — and is not',
    body: `
      <p>SchemeConnect lists central and state government scholarships and schemes, checks the details you give us against their published eligibility rules, and explains in plain language why you matched. Every scheme we show links back to its official government page or circular.</p>
      <div class="terms-callout"><b>Important:</b> SchemeConnect is an independent, privately operated platform. We are not affiliated with, endorsed by, or acting on behalf of any ministry, department, the National Scholarship Portal (NSP), or any state government. We hold no data-sharing agreement or API access with NSP or any state portal — our scheme catalogue is compiled automatically from publicly published government pages and guideline documents. Applications are always submitted by you on the official government portal, never through us.</div>`,
  },
  {
    id: 't2',
    title: 'Beta service and where we have coverage',
    body: `
      <p>SchemeConnect is a new service running as a public beta. Features may change, be withdrawn, or behave imperfectly while we are in beta.</p>
      <p>Our catalogue does not yet cover every state and union territory, and it does not cover every scheme within the states it does reach. Where we have no verified data for your state, we tell you so and show you no results, rather than a list we cannot stand behind.</p>
      <div class="terms-callout"><b>What "no results" means:</b> an empty or unavailable result for your state means we have no verified scheme data for it yet — <b>not</b> that no scheme exists, and not that you are ineligible. Schemes you qualify for may well be open. Check the National Scholarship Portal and your state's own portal directly.</div>`,
  },
  {
    id: 't3',
    title: 'Who can use SchemeConnect',
    body: `
      <p>SchemeConnect is intended for students in India, and for the parents, guardians, teachers and institute coordinators who help them. You may use it if you are at least 18 years old, or if you are under 18 and the conditions in section 4 are met.</p>
      <p>If you sign up on behalf of an institute, you confirm that you are authorised by that institute to accept these terms on its behalf and to bind it to the obligations in section 10.</p>`,
  },
  {
    id: 't4',
    title: 'Users under 18 and parental consent',
    body: `
      <p>Many of the students SchemeConnect is built for are school students under the age of 18. We process children's personal data in line with the <b>Digital Personal Data Protection Act, 2023 (DPDP Act)</b>.</p>
      <ul>
        <li>If you are under 18, you must tell us so at sign-up, and a parent or legal guardian must give verifiable consent before your profile is created. Your institute may facilitate this, but it does not replace it.</li>
        <li>A parent or guardian may at any time review, correct, restrict or delete the data held about their child, and may withdraw consent — after which we stop processing that child's data and close the profile.</li>
        <li>We do not carry out behavioural tracking or monitoring of children, and we never serve targeted or behavioural advertising to a user we know or believe to be a child.</li>
        <li>We do not process a child's data in any way likely to cause a detrimental effect on their wellbeing.</li>
      </ul>
      <p>If we learn that a profile for a user under 18 was created without the required consent, we will suspend it until consent is provided, and delete it if it is not.</p>`,
  },
  {
    id: 't5',
    title: 'Your account and OTP verification',
    body: `
      <p>You do not need an account to browse the scheme catalogue. An account is what lets you save your eligibility profile, keep matched schemes, and return to your results later.</p>
      <p>Accounts are created and accessed using a one-time code (OTP) sent to your mobile number (students) or work email (institutes). There is no password. You are responsible for keeping access to that number or inbox secure, and for everything done through your account.</p>
      <ul>
        <li>Never share your one-time code with anyone. We will never ask you for it by phone, SMS or email.</li>
        <li>Use a mobile number or email address that belongs to you or, for a student under 18, to their parent or guardian.</li>
        <li>Tell us promptly if you believe someone else has accessed your account.</li>
      </ul>`,
  },
  {
    id: 't6',
    title: 'Self-reported details and match accuracy',
    body: `
      <p>The details you enter — state, class or course, category, family income, gender and disability status — are self-reported. They are shown as "Self-reported" on your profile and are used only to compare you against published scheme criteria. You agree to give accurate information and to keep it up to date; an inaccurate answer produces an inaccurate match.</p>
      <p>Where you do not match a scheme, we show you which criterion was not met, so an absence from your list is explained rather than unexplained. Where our scraper could not read a criterion from the government source, we mark it as unknown rather than assuming it passes.</p>
      <div class="terms-callout"><b>A match is an indication, not a decision.</b> It means your self-reported details appear to meet a scheme's published criteria as our system read them. Only the issuing government authority can determine whether you actually qualify, verify your documents, or approve and disburse an award. Its decision is final and we have no part in it.</div>`,
  },
  {
    id: 't7',
    title: 'Optional document verification',
    body: `
      <p>You may optionally upload documents — identity, income or education proof — to raise the accuracy of your matches and earn a verified badge. Verification is never required to search, view or match with schemes.</p>
      <ul>
        <li>Documents are used only to confirm the details on your profile.</li>
        <li>Uploaded documents are not shared with any institute, third party or government body without your explicit consent.</li>
        <li>You may withdraw a verification or ask us to delete an uploaded document at any time.</li>
        <li>Uploading forged, altered or someone else's documents is a serious breach of these terms and will result in your account being closed.</li>
      </ul>`,
  },
  {
    id: 't8',
    title: 'Scheme information, freshness and official sources',
    body: `
      <p>Scheme details — amounts, deadlines, criteria and document checklists — are collected automatically from official government pages and guideline circulars, and parsed by software. Each scheme carries a "last verified" date so you can judge for yourself how current it is, and a link to the exact source page or document it came from.</p>
      <p>Two consequences follow, and you should read them before relying on anything here:</p>
      <ul>
        <li><b>Parsing can be wrong.</b> Criteria are extracted from prose by pattern matching, not read by a human. Where we show a criterion we also show the sentence it came from, so you can check our reading against the source.</li>
        <li><b>Data goes stale.</b> Because we have no data feed from NSP or state portals, the catalogue is only as current as the last scrape. Government schemes can change, close, reopen or revise their rules at any time, and a change may reach the official portal well before it reaches us.</li>
      </ul>
      <div class="terms-callout"><b>Always confirm on the official page.</b> Check the scheme's status, deadline and requirements on the government page linked from the scheme before you rely on it or plan around it. Where our listing and the official source differ, <b>the official source governs</b>.</div>`,
  },
  {
    id: 't9',
    title: 'Applying on government portals',
    body: `
      <p>When you choose to apply, we send you to the scheme's official application page on the National Scholarship Portal or the relevant government portal. From that point your application is governed entirely by that portal's own terms and privacy policy.</p>
      <p>We do not submit applications for you, cannot see or influence their outcome, and cannot recover a missed deadline on your behalf. Deadline reminders are a convenience, not a guarantee — a reminder may be delayed or fail to arrive, and it remains your responsibility to track the deadlines that matter to you.</p>`,
  },
  {
    id: 't10',
    title: 'Terms for institutes and coordinators',
    body: `
      <p>If you register as an institute, these additional terms apply to you and to every coordinator acting under your account.</p>
      <ul>
        <li>You may upload student data only for students enrolled with your institute, and only where you have a lawful basis under the DPDP Act and the necessary consent to do so.</li>
        <li><b>Where a student is under 18, you must have obtained verifiable consent from that student's parent or legal guardian before uploading their data.</b> By uploading a batch you confirm you have done so and can evidence it on request. This obligation is yours, not ours.</li>
        <li>You must inform students (and their parents or guardians, where they are minors) that their details are being shared with SchemeConnect for the purpose of scheme matching, and tell them how to withdraw.</li>
        <li>Your dashboard shows the student details your institute uploaded — class, state, category, income and so on — alongside each student's scheme matches and the reason for each one, so your coordinators can act on them.</li>
        <li><b>What a student adds themselves stays theirs.</b> Verification documents they upload, and details they enter or correct on their own SchemeConnect account, are not shown to your institute. You see the data you supplied, not their private profile.</li>
        <li>Because you can see these details, you are responsible for them: show them only to staff who need them to help the student, do not copy them into other systems, and delete your local copies when they are no longer needed.</li>
        <li>Keep uploaded data accurate, tell us about students who leave, and use it only to help those students find and apply for schemes — never for marketing, profiling, resale or any unrelated purpose.</li>
        <li>You are responsible for who you grant coordinator access to and for what they do with it.</li>
        <li>You may not charge students a fee for access to information SchemeConnect provides to them free.</li>
      </ul>`,
  },
  {
    id: 't11',
    title: 'Privacy, consent and data sharing',
    body: `
      <p>We collect only what we need to match you with schemes and to send you the reminders you ask for. <b>Your data is not sold.</b> It is not shared with an institute, a lender, an agent or any other third party without your explicit, revocable consent.</p>
      <ul>
        <li>If your institute enrolled you by uploading a batch, it can see the details it supplied about you — class, state, category and income — together with the schemes you matched. It supplied that data and remains responsible for it.</li>
        <li>What you add yourself is yours. Verification documents you upload, and details you enter or correct on your own account, are not shown to your institute.</li>
        <li>We use a small number of service providers to operate the product — for example to send one-time codes and reminders. They process your data only on our instructions and only for that purpose.</li>
        <li>We do not use your data for behavioural advertising, and we do not profile children (see section 4).</li>
        <li>You can view, correct, export or delete your details at any time from your profile.</li>
        <li>Deleting your account removes your profile and uploaded documents from our systems, subject to any records we are required to retain by law.</li>
      </ul>
      <p>Our Privacy Policy explains all of this in full and forms part of these terms.</p>`,
  },
  {
    id: 't12',
    title: 'Free to use, fees, fraud and scam warnings',
    body: `
      <p>Checking your eligibility on SchemeConnect is free for students and will remain so. We do not put eligibility checking, your matches, or the official apply links behind a paid tier. If we ever introduce optional paid features, they will never gate the core eligibility check.</p>
      <p>We will never ask you to pay a fee, a deposit or a "processing charge" to be matched with a scheme — and no legitimate government scholarship requires you to pay to apply.</p>
      <div class="terms-callout"><b>Watch out:</b> messages promising guaranteed scholarships in exchange for a fee, an OTP or your bank details are fraudulent. Report anything suspicious to us, and never share your one-time code, bank details or documents with anyone who contacts you claiming to be from SchemeConnect.</div>`,
  },
  {
    id: 't13',
    title: 'Acceptable use',
    body: `
      <p>You agree not to:</p>
      <ul>
        <li>Create an account using someone else's identity, number or documents.</li>
        <li>Submit false, forged or misleading information.</li>
        <li>Scrape, copy, republish or resell our scheme listings, verification data or match results.</li>
        <li>Attempt to gain access to another user's profile or to any part of our systems.</li>
        <li>Use the service to charge students for access to information we provide free.</li>
        <li>Present SchemeConnect as an official government service, or as a route to a guaranteed award.</li>
      </ul>
      <p>We may suspend or close accounts that breach these rules.</p>`,
  },
  {
    id: 't14',
    title: 'Service availability and limitation of liability',
    body: `
      <p>We aim to keep SchemeConnect available and responsive, with particular care during the application-deadline months when demand is highest. We cannot promise uninterrupted service: maintenance, outages and dependencies outside our control will sometimes interrupt it, and this is a beta service.</p>
      <p>SchemeConnect is provided on an "as is" and "as available" basis. We do not guarantee that a scheme will be available, that you will be found eligible, that you will be awarded any amount, that your state is covered, or that our listing of a deadline or criterion is free of error. To the fullest extent permitted by law, we are not liable for a missed deadline, a rejected or unsuccessful application, an out-of-date or incorrectly parsed scheme detail, a reminder that did not arrive, or any loss arising from your use of a government portal.</p>
      <p>Nothing in these terms limits any liability that cannot be limited under applicable law, including under the DPDP Act.</p>`,
  },
  {
    id: 't15',
    title: 'Changes to these terms',
    body: `
      <p>We may update these terms as the service grows and as our state coverage expands. If a change materially affects your rights, we will tell you in the app or by email before it takes effect and ask you to accept the updated terms. Continuing to use SchemeConnect after that point means you accept them.</p>
      <p>The version you accepted is recorded against your account.</p>`,
  },
  {
    id: 't16',
    title: 'Closing your account',
    body: `
      <p>You may close your account at any time from your profile, and a parent or guardian may close a child's account on their behalf. Institutes may close their account by contacting us; student profiles that students have claimed themselves remain theirs and are not deleted when an institute leaves.</p>`,
  },
  {
    id: 't17',
    title: 'Accessibility, support and contact',
    body: `
      <p>We build SchemeConnect to meet WCAG 2.1 AA and to work with a screen reader, on a budget Android phone, and over a slow or intermittent connection. If any part of the product is not usable for you, tell us — we treat that as a defect, not a feature request.</p>
      <p>For questions about these terms, a privacy or parental-consent request, an accessibility problem, or a suspected scam, write to <a href="mailto:support@schemeconnect.com">support@schemeconnect.com</a>. We aim to respond within 3 business days.</p>`,
  },
];
