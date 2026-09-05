import { SectionHeader, SectionStack, SettingsCard, Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';
import KeywordEditor from '../../KeywordEditor';

export default function KeywordsSection({ form }: { form: SettingsForm }) {
  const { globalKeywordPatterns, setGlobalKeywordPatterns, keywordAlertsEnabled, setKeywordAlertsEnabled } = form;
  return (
    <>
      <SectionHeader title="Keywords" />

      <SectionStack>
        <SettingsCard title="Keyword Alerts">
          <Toggle
            value={keywordAlertsEnabled}
            onChange={setKeywordAlertsEnabled}
            label="Enable keyword/regex pattern matching alerts"
          />
        </SettingsCard>

        <SettingsCard
          title="Global Keyword Patterns"
          blurb={
            <>
              Add patterns to match against messages globally. Use <strong className="text-oct-text">Contains</strong> for substring matches, <strong className="text-oct-text">Exact</strong> for whole-word matches, or <strong className="text-oct-text">Regex</strong> for advanced patterns.
            </>
          }
        >
          <KeywordEditor patterns={globalKeywordPatterns} onChange={setGlobalKeywordPatterns} />
        </SettingsCard>
      </SectionStack>
    </>
  );
}
