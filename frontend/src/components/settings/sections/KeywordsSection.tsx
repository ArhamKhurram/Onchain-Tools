import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';
import KeywordEditor from '../../KeywordEditor';

export default function KeywordsSection({ form }: { form: SettingsForm }) {
  const { globalKeywordPatterns, setGlobalKeywordPatterns, keywordAlertsEnabled, setKeywordAlertsEnabled } = form;
  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-4">Keywords</h3>

                  <div className="space-y-5">
                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-2">Keyword Alerts</h4>
                      <Toggle
                        value={keywordAlertsEnabled}
                        onChange={setKeywordAlertsEnabled}
                        label="Enable keyword/regex pattern matching alerts"
                      />
                    </div>

                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-2">Global Keyword Patterns</h4>
                      <p className="text-sm text-oct-muted mb-2">
                        Add patterns to match against messages globally. Use <strong className="text-oct-text">Contains</strong> for substring matches, <strong className="text-oct-text">Exact</strong> for whole-word matches, or <strong className="text-oct-text">Regex</strong> for advanced patterns.
                      </p>
                      <KeywordEditor patterns={globalKeywordPatterns} onChange={setGlobalKeywordPatterns} />
                    </div>
                  </div>
                </div>
              </>
  );
}
