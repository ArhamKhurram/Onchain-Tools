import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { AppConfig, KeywordPattern, KeywordMatchMode } from '../../types';
import type { AppState } from '../../stores/appStore';

interface KeywordsTabProps {
  config: AppConfig | null;
  updateConfig: AppState['updateConfig'];
  newKeywordPattern: string;
  setNewKeywordPattern: Dispatch<SetStateAction<string>>;
  newKeywordMatchMode: KeywordMatchMode;
  setNewKeywordMatchMode: Dispatch<SetStateAction<KeywordMatchMode>>;
  newKeywordLabel: string;
  setNewKeywordLabel: Dispatch<SetStateAction<string>>;
  roomKeywordPatterns: KeywordPattern[];
  setRoomKeywordPatterns: Dispatch<SetStateAction<KeywordPattern[]>>;
}

export default function KeywordsTab({
  config,
  updateConfig,
  newKeywordPattern,
  setNewKeywordPattern,
  newKeywordMatchMode,
  setNewKeywordMatchMode,
  newKeywordLabel,
  setNewKeywordLabel,
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
              <div className="text-xs text-discord-text-muted bg-discord-dark rounded px-3 py-2 mb-4 space-y-1">
                <p className="font-semibold text-discord-text-muted/80">Regex examples:</p>
                <p><code className="text-orange-400/80 font-mono">stealth\s*(launch|drop)</code> — stealth launch, stealthdrop</p>
                <p><code className="text-orange-400/80 font-mono">\b(airdrop|air\s*drop)\b</code> — airdrop, air drop (whole word)</p>
                <p><code className="text-orange-400/80 font-mono">deploy(ed|ing)?</code> — deploy, deployed, deploying</p>
                <p><code className="text-orange-400/80 font-mono">ca\s*[:=]\s*0x[a-f0-9]+</code> — ca: 0xABC..., CA=0x...</p>
                <p className="pt-1">Build & test patterns at <a href="https://regex101.com" target="_blank" rel="noopener noreferrer" className="text-discord-blurple hover:underline">regex101.com</a></p>
              </div>

              <div className="space-y-3 mb-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newKeywordPattern}
                    onChange={(e) => setNewKeywordPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newKeywordPattern.trim()) {
                        setRoomKeywordPatterns((prev) => [...prev, { pattern: newKeywordPattern.trim(), matchMode: newKeywordMatchMode, label: newKeywordLabel.trim() || undefined }]);
                        setNewKeywordPattern('');
                        setNewKeywordLabel('');
                      }
                    }}
                    placeholder={
                      newKeywordMatchMode === 'regex' ? 'Regex pattern (e.g. launch|stealth)'
                      : newKeywordMatchMode === 'exact' ? 'Exact word (e.g. launch)'
                      : 'Keyword (e.g. stealth launch)'
                    }
                    className="flex-1 bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple font-mono"
                  />
                  <button
                    onClick={() => {
                      if (!newKeywordPattern.trim()) return;
                      setRoomKeywordPatterns((prev) => [...prev, { pattern: newKeywordPattern.trim(), matchMode: newKeywordMatchMode, label: newKeywordLabel.trim() || undefined }]);
                      setNewKeywordPattern('');
                      setNewKeywordLabel('');
                    }}
                    className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover rounded text-sm text-white transition-colors"
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex rounded overflow-hidden border border-discord-divider">
                    {(['includes', 'exact', 'regex'] as KeywordMatchMode[]).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setNewKeywordMatchMode(mode)}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          newKeywordMatchMode === mode
                            ? 'bg-discord-blurple text-white'
                            : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                        }`}
                      >
                        {mode === 'includes' ? 'Contains' : mode === 'exact' ? 'Exact' : 'Regex'}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={newKeywordLabel}
                    onChange={(e) => setNewKeywordLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="flex-1 bg-discord-dark border-none rounded px-3 py-1.5 text-xs text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                  />
                </div>
              </div>

              <div className="space-y-1">
                {roomKeywordPatterns.length === 0 && (
                  <p className="text-sm text-discord-text-muted text-center py-4">
                    No keyword patterns configured.
                  </p>
                )}
                {roomKeywordPatterns.map((kw, idx) => (
                  <div key={idx} className="flex items-center justify-between px-3 py-2 bg-discord-dark rounded">
                    <div className="flex items-center gap-2 min-w-0">
                      {(kw.matchMode === 'regex' || (!kw.matchMode && kw.isRegex)) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-400/20 text-orange-400 font-semibold shrink-0">
                          REGEX
                        </span>
                      )}
                      {kw.matchMode === 'exact' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-discord-blurple/20 text-discord-blurple font-semibold shrink-0">
                          EXACT
                        </span>
                      )}
                      <span className="text-sm text-discord-text font-mono truncate">{kw.pattern}</span>
                      {kw.label && (
                        <span className="text-[11px] text-discord-text-muted">({kw.label})</span>
                      )}
                    </div>
                    <button
                      onClick={() => setRoomKeywordPatterns((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-discord-text-muted hover:text-discord-red shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </>
  );
}
