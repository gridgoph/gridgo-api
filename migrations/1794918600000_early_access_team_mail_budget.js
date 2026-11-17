/** Shared, bounded team-alert delivery budget; applicant invites are exempt. */
export const up = pgm => pgm.sql(`
  CREATE TABLE early_access_team_mail_budget (
    budget_day date PRIMARY KEY,
    attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 100)
  );
`);
export const down = () => { throw new Error('Team mail budgets require a forward migration'); };
