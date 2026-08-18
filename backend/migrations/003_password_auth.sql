-- Password sign-in, as an alternative to the emailed one-time code.
--
-- The OTP flow is what the PRD and the approved wireframes specify, and it
-- stays the default. But it can only work where the deployment can actually
-- send mail, and a host that blocks outbound SMTP — or an account with no
-- verified sending domain — leaves a user unable to sign in at all. AUTH_MODE
-- selects between them.
--
-- Nullable: an account created under one mode has no credential for the other,
-- and both modes have to tolerate that.

alter table users add column password_hash text;

-- Failed sign-in attempts are throttled through the existing rate_limits table,
-- keyed by identifier and IP, exactly as OTP issuance is.
comment on column users.password_hash is
  'scrypt$<base64 salt>$<base64 key>. Null for accounts that sign in by one-time code.';
