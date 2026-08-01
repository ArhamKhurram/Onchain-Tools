import type { Dispatch, SetStateAction } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AppConfig, KeywordPattern } from '../../types';
import type { AppState } from '../../stores/appStore';
import KeywordEditor from '../KeywordEditor';

interface KeywordsTabProps {
  config: AppConfig | null;
  updateConfig: AppState['updateConfig'];
  roomKeywordPatterns: KeywordPattern[];
  setRoomKeywordPatterns: Dispatch<SetStateAction<KeywordPattern[]>>;
}

export default function KeywordsTab({
  config,
  updateConfig,
  roomKeywordPatterns,
  setRoomKeywordPatterns,
}: KeywordsTabProps) {
  return (
            <>
              {/* Global keyword alerts toggle */}
              <div className={`mb-4 p-3 rounded-cockpit border-2 ${config?.keywordAlertsEnabled ? 'border-oct-border bg-oct-surface' : 'border-oct-flame bg-oct-flame/15'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <div
                    className={`w-10 h-5 rounded-full border-2 border-oct-border transition-colors duration-100 relative shrink-0 ${
                      config?.keywordAlertsEnabled ? 'bg-oct-green' : 'bg-oct-surface-raised'
                    }`}
                    onClick={async () => {
                      await updateConfig({ keywordAlertsEnabled: !(config?.keywordAlertsEnabled ?? true) });
                    }}
                  >
                    <div
                      className={`absolute top-0 w-4 h-4 bg-oct-text rounded-full transition-transform duration-100 ${
                        config?.keywordAlertsEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </div>
                  <span className="text-sm text-oct-text">
                    Keyword alerts {config?.keywordAlertsEnabled ? 'enabled' : 'disabled'}
                  </span>
                </label>
                {!config?.keywordAlertsEnabled && (
                  <div className="flex items-center gap-1.5 mt-2 text-xs text-oct-flame">
                    <AlertTriangle size={12} className="shrink-0" />
                    <span>Keyword matching is disabled globally. Room keywords won't trigger until enabled.</span>
                  </div>
                )}
              </div>

              <p className="text-sm text-oct-muted mb-2">
                Add patterns to match against messages in this room. Use <strong className="text-oct-text">Contains</strong> for substring matches, <strong className="text-oct-text">Exact</strong> for whole-word matches, or <strong className="text-oct-text">Regex</strong> for advanced patterns. Matches trigger an orange highlight and alert.
              </p>

              <KeywordEditor patterns={roomKeywordPatterns} onChange={setRoomKeywordPatterns} />
            </>
  );
}
