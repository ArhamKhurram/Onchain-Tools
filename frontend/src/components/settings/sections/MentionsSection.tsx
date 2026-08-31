import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

export default function MentionsSection({ form }: { form: SettingsForm }) {
  const { mentionsUserEnabled, setMentionsUserEnabled, mentionsRoleEnabled, setMentionsRoleEnabled, mentionsHereEnabled, setMentionsHereEnabled, mentionsEveryoneEnabled, setMentionsEveryoneEnabled } = form;
  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-1">Mentions</h3>
                  <p className="text-sm text-oct-muted mb-4">
                    Collect messages where you were mentioned into the <strong className="text-oct-text">Mentions</strong> room. Only channels already added to your rooms are scanned.
                  </p>

                  <div className="oct-card p-4 sm:p-5 space-y-3">
                    <Toggle
                      value={mentionsUserEnabled}
                      onChange={setMentionsUserEnabled}
                      label="User mentions — when someone @-mentions you directly"
                    />
                    <Toggle
                      value={mentionsRoleEnabled}
                      onChange={setMentionsRoleEnabled}
                      label="Role mentions — when one of your roles is mentioned"
                    />
                    <Toggle
                      value={mentionsHereEnabled}
                      onChange={setMentionsHereEnabled}
                      label="@here — when @here is used in a channel you monitor"
                    />
                    <Toggle
                      value={mentionsEveryoneEnabled}
                      onChange={setMentionsEveryoneEnabled}
                      label="@everyone — when @everyone is used in a channel you monitor"
                    />
                  </div>
                </div>
              </>
  );
}
