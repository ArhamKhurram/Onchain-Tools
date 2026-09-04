import { SectionHeader, SettingsCard, Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

export default function MentionsSection({ form }: { form: SettingsForm }) {
  const { mentionsUserEnabled, setMentionsUserEnabled, mentionsRoleEnabled, setMentionsRoleEnabled, mentionsHereEnabled, setMentionsHereEnabled, mentionsEveryoneEnabled, setMentionsEveryoneEnabled } = form;
  return (
    <>
      <SectionHeader
        title="Mentions"
        blurb={
          <>
            Collect messages where you were mentioned into the <strong className="text-oct-text">Mentions</strong> room. Only channels already added to your rooms are scanned.
          </>
        }
      />

      <SettingsCard>
        <div className="space-y-cozy">
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
      </SettingsCard>
    </>
  );
}
