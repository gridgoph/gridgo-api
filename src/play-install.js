/** Internal SQL expressions only; never pass request input as an expression. */
export const knownPlayInstallSql = (userExpression, appExpression) => `EXISTS (
  SELECT 1 FROM device_tokens pd WHERE pd.user_id=${userExpression} AND pd.platform='android'
    AND pd.data->>'appRole'=${appExpression} AND pd.data->>'installChannel'='play'
)`;

/** An explicit Android Play registration is evidence for this account/app only. */
export async function hasKnownPlayInstall(database, userId, app) {
  return (await database.query(`SELECT ${knownPlayInstallSql('$1', '$2')} AS known_play`, [userId, app])).rows[0].known_play;
}
