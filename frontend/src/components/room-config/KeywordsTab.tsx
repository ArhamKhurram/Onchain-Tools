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
              <div className={`mb-4 rounded-lg p-3 ${config?.keywordAlertsEnabled ? 'bg-discord-dark/50' : 'bg-discord-red/10 border border-discord-red/20'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      config?.keywordAlertsEnabled ? 'bg-discord-green' : 'bg-discord-input'
                    }`}
                    onClick={async () => {
                      await updateConfig({ keywordAlertsEnabled: !(config?.keywordAlertsEnabled ?? true) });
                    }}
                  >
                    <div
                      className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        config?.keywordAlertsEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                  <span className="text-sm text-discord-text">
                    Keyword alerts {config?.keywordAlertsEnabled ? 'enabled' : 'disabled'}
                  </span>
                </label>
                {!config?.keywordAlertsEnabled && (
                  <div className="flex items-center gap-1.5 mt-2 text-xs text-discord-red">
                    <AlertTriangle size={12} />
                    <span>Keyword matching is disabled globally. Room keywords won't trigger until enabled.</span>
                  </div>
                )}
              </div>

              <p className="text-sm text-discord-text-muted mb-2">
                Add patterns to match against messages in this room. Use <strong className="text-discord-text">Contains</strong> for substring matches, <strong className="text-discord-text">Exact</strong> for whole-word matches, or <strong className="text-discord-text">Regex</strong> for advanced patterns. Matches trigger an orange highlight and alert.
              </p>

              <KeywordEditor patterns={roomKeywordPatterns} onChange={setRoomKeywordPatterns} />
            </>
  );
}
