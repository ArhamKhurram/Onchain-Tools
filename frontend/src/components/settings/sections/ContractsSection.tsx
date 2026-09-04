import type { SolPlatform, EvmPlatform, ContractClickAction } from '../../../types';
import ColorPickerWithAlpha from '../../ColorPickerWithAlpha';
import { cn } from '../../../lib/utils';
import {
  Field,
  FieldRow,
  INPUT_CLASS,
  INPUT_MONO_CLASS,
  SectionHeader,
  SectionStack,
  SegmentedControl,
  SettingsCard,
  Toggle,
} from '../fields';
import type { SettingsForm } from '../useSettingsForm';

const CLICK_ACTION_OPTIONS: readonly { value: ContractClickAction; label: string }[] = [
  { value: 'copy', label: 'Copy' },
  { value: 'copy_open', label: 'Copy + Open' },
  { value: 'open', label: 'Open Only' },
];

const SOL_PLATFORM_OPTIONS: readonly { value: SolPlatform; label: string }[] = [
  { value: 'axiom', label: 'Axiom' },
  { value: 'padre', label: 'Padre' },
  { value: 'bloom', label: 'Bloom' },
  { value: 'gmgn', label: 'GMGN' },
  { value: 'custom', label: 'Custom' },
];

const EVM_PLATFORM_OPTIONS: readonly { value: EvmPlatform; label: string }[] = [
  { value: 'gmgn', label: 'GMGN' },
  { value: 'bloom', label: 'Bloom' },
  { value: 'custom', label: 'Custom' },
];

const EVM_DEFAULT = '#fee75c';
const SOL_DEFAULT = '#14f195';

export default function ContractsSection({ form }: { form: SettingsForm }) {
  const { evmAddressColor, setEvmAddressColor, solAddressColor, setSolAddressColor, solPlatform, setSolPlatform, evmPlatform, setEvmPlatform, customSolUrl, setCustomSolUrl, customEvmUrl, setCustomEvmUrl, contractClickAction, setContractClickAction, showFullContractAddress, setShowFullContractAddress, autoOpenHighlightedContracts, setAutoOpenHighlightedContracts, signalConvergenceWindowMinutes, setSignalConvergenceWindowMinutes } = form;

  const colorRow = (label: string, value: string, fallback: string, set: (c: string) => void) => (
    <FieldRow className="flex items-center gap-comfy">
      <ColorPickerWithAlpha value={value} onChange={set} defaultColor={fallback} showTextInput />
      <span className="type-body text-oct-text flex-1">{label}</span>
      {value !== fallback && (
        <button
          type="button"
          onClick={() => set(fallback)}
          className="type-caption font-mono uppercase tracking-wide text-oct-muted hover:text-oct-accent shrink-0"
        >
          Reset
        </button>
      )}
    </FieldRow>
  );

  return (
    <>
      <SectionHeader title="Contracts" />

      <SectionStack>
        <SettingsCard title="Contract Click Action" blurb="What happens when you click a contract address in chat.">
          <SegmentedControl value={contractClickAction} onChange={setContractClickAction} options={CLICK_ACTION_OPTIONS} />
        </SettingsCard>

        <SettingsCard title="Display Full Contract Address">
          <Toggle
            value={showFullContractAddress}
            onChange={setShowFullContractAddress}
            label="Show the full contract address in chat and the contract list instead of the shortened form (0x1234...abcd)"
          />
        </SettingsCard>

        <SettingsCard title="Trading Platform" blurb="Choose which trading platform opens when you click a contract address.">
          <div className="space-y-cozy">
            <Field label="SOL Platform">
              <SegmentedControl value={solPlatform} onChange={setSolPlatform} options={SOL_PLATFORM_OPTIONS} />
              {solPlatform === 'custom' && (
                <input
                  type="text"
                  value={customSolUrl}
                  onChange={(e) => setCustomSolUrl(e.target.value)}
                  placeholder="https://example.com/token/{address}"
                  className={cn(INPUT_MONO_CLASS, 'mt-cozy')}
                />
              )}
            </Field>
            <Field label="EVM Platform">
              <SegmentedControl value={evmPlatform} onChange={setEvmPlatform} options={EVM_PLATFORM_OPTIONS} />
              {evmPlatform === 'custom' && (
                <input
                  type="text"
                  value={customEvmUrl}
                  onChange={(e) => setCustomEvmUrl(e.target.value)}
                  placeholder="https://example.com/token/{address}"
                  className={cn(INPUT_MONO_CLASS, 'mt-cozy')}
                />
              )}
            </Field>
          </div>
        </SettingsCard>

        <SettingsCard title="Auto-Open Highlighted Contracts">
          <Toggle
            value={autoOpenHighlightedContracts}
            onChange={setAutoOpenHighlightedContracts}
            label="Automatically open a new tab when a highlighted user posts a contract address"
          />
        </SettingsCard>

        <SettingsCard
          title="Signal Convergence Window"
          blurb="When a contract appears in your feed and a tracked FOMO user buys the same token within this window, a convergence alert fires."
        >
          <div className="flex items-center gap-comfy">
            <input
              type="number"
              min={1}
              max={240}
              value={signalConvergenceWindowMinutes}
              onChange={(e) => setSignalConvergenceWindowMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 30)))}
              className={cn(INPUT_CLASS, 'w-20 type-data')}
            />
            <span className="type-body text-oct-muted">minutes (default 30)</span>
          </div>
        </SettingsCard>

        <SettingsCard title="Address Colors" blurb="Customize highlight colors for detected contract addresses by chain type.">
          <div className="space-y-cozy">
            {colorRow('EVM (0x...)', evmAddressColor, EVM_DEFAULT, setEvmAddressColor)}
            {colorRow('SOL', solAddressColor, SOL_DEFAULT, setSolAddressColor)}
          </div>
        </SettingsCard>
      </SectionStack>
    </>
  );
}
