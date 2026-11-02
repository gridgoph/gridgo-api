/**
 * Client Home (gridgo-client#335): a saved light/dark choice, the reporter of an
 * in-app issue report, and the one-time PHP 15 bug-report voucher that staff grant
 * by confirming a tester's report. Contracts: docs/CLIENT_HOME_API.md.
 *
 * Once per tester ever is the existing UNIQUE(kind, client_id) on tester_rewards.
 * A report's confirmation is immutable, and a granted/paused reward is owned by the
 * report's own reporter. Adding columns with constant defaults rewrites no table.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_profiles
      ADD COLUMN theme_preference text NOT NULL DEFAULT 'system'
        CONSTRAINT client_profiles_theme_preference_check CHECK (theme_preference IN ('system', 'light', 'dark'));

    ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_purpose_check;
    ALTER TABLE voucher_campaigns ADD CONSTRAINT voucher_campaigns_purpose_check
      CHECK (purpose IN ('manual','survey','founding_tester','tester_referral','founding_launch','friend_pass','tester_bug_report'));

    ALTER TABLE tester_rewards DROP CONSTRAINT tester_rewards_kind_check;
    ALTER TABLE tester_rewards ADD CONSTRAINT tester_rewards_kind_check CHECK (kind IN ('mission','referral','bug_report'));
    ALTER TABLE tester_rewards DROP CONSTRAINT tester_rewards_check;
    ALTER TABLE tester_rewards ADD CONSTRAINT tester_rewards_check CHECK(
      (kind='mission' AND inviter_id IS NULL AND invite_id IS NULL AND inviter_voucher_id IS NULL)
      OR (kind='referral' AND inviter_id IS NOT NULL AND invite_id IS NOT NULL AND inviter_id<>client_id AND amount_minor>0 AND amount_minor%2=0)
      OR (kind='bug_report' AND inviter_id IS NULL AND invite_id IS NULL AND inviter_voucher_id IS NULL AND amount_minor>0));

    ALTER TABLE issue_reports
      ADD COLUMN reporter_id text REFERENCES users(id),
      ADD COLUMN bug_confirmed_at timestamptz,
      ADD COLUMN bug_confirmed_by text REFERENCES users(id),
      ADD COLUMN bug_reward_outcome text
        CONSTRAINT issue_reports_bug_reward_outcome_check
        CHECK (bug_reward_outcome IN ('granted', 'paused', 'already_rewarded', 'not_tester', 'no_reporter')),
      ADD COLUMN bug_reward_id text UNIQUE REFERENCES tester_rewards(id),
      ADD CONSTRAINT issue_reports_bug_confirmation_check CHECK (
        (bug_confirmed_at IS NULL) = (bug_confirmed_by IS NULL)
        AND (bug_confirmed_at IS NULL) = (bug_reward_outcome IS NULL)
        AND (bug_reward_id IS NOT NULL) = coalesce(bug_reward_outcome IN ('granted', 'paused'), false)
        AND coalesce((bug_reward_outcome = 'no_reporter') = (reporter_id IS NULL), true)
      );
    CREATE INDEX issue_reports_reporter_idx ON issue_reports (reporter_id) WHERE reporter_id IS NOT NULL;

    CREATE FUNCTION guard_issue_report_bug_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.reporter_id IS DISTINCT FROM NEW.reporter_id THEN
        RAISE EXCEPTION 'issue report reporter is immutable' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.bug_confirmed_at IS NOT NULL
        AND ROW(OLD.bug_confirmed_at, OLD.bug_confirmed_by, OLD.bug_reward_outcome, OLD.bug_reward_id)
          IS DISTINCT FROM ROW(NEW.bug_confirmed_at, NEW.bug_confirmed_by, NEW.bug_reward_outcome, NEW.bug_reward_id) THEN
        RAISE EXCEPTION 'issue report bug confirmation is immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.bug_reward_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tester_rewards WHERE id = NEW.bug_reward_id AND kind = 'bug_report' AND client_id = NEW.reporter_id
      ) THEN
        RAISE EXCEPTION 'issue report bug reward owner mismatch' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER issue_report_bug_confirmation_guard BEFORE INSERT OR UPDATE ON issue_reports
      FOR EACH ROW EXECUTE FUNCTION guard_issue_report_bug_confirmation();
  `);
}

export async function down() {
  throw new Error('Bug-report rewards and issue report confirmations require a forward migration');
}
