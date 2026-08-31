import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ChannelRef, KeywordPattern, HighlightMode } from '../types';
import { X } from 'lucide-react';
import { normalizeUserIdentifier, appendUserIdentifiers } from '../utils/userIdentifiers';
import { useUserNameMap } from '../hooks/useUserNameMap';
import ChannelsTab from './room-config/ChannelsTab';
import UsersTab from './room-config/UsersTab';
import FilterTab from './room-config/FilterTab';
import KeywordsTab from './room-config/KeywordsTab';

export default function RoomConfig() {
  const configModalOpen = useAppStore((s) => s.configModalOpen);
  const configModalTab = useAppStore((s) => s.configModalTab);
  const editingRoom = useAppStore((s) => s.editingRoom);
  const closeConfigModal = useAppStore((s) => s.closeConfigModal);
  const guilds = useAppStore((s) => s.guilds);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const createRoom = useAppStore((s) => s.createRoom);
  const updateRoom = useAppStore((s) => s.updateRoom);
  const config = useAppStore((s) => s.config);
  const fetchGuilds = useAppStore((s) => s.fetchGuilds);
  const fetchDMChannels = useAppStore((s) => s.fetchDMChannels);
  const fetchConfig = useAppStore((s) => s.fetchConfig);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const telegramChats = useAppStore((s) => s.telegramChats);
  const fetchTelegramChats = useAppStore((s) => s.fetchTelegramChats);
  const authStatus = useAppStore((s) => s.authStatus);

  // Live author-name lookup without a whole-messages-map subscription (which
  // re-rendered the open modal on every incoming message in any room).
  const userNameMap = useUserNameMap();

  const [name, setName] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<ChannelRef[]>([]);
  const [highlightedUsers, setHighlightedUsers] = useState<string[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<string[]>([]);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [roomColor, setRoomColor] = useState('');
  const [hotkey, setHotkey] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newFilterUser, setNewFilterUser] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'channels' | 'users' | 'filter' | 'keywords'>('channels');
  const [platformTab, setPlatformTab] = useState<'discord' | 'telegram'>('discord');
  const [roomKeywordPatterns, setRoomKeywordPatterns] = useState<KeywordPattern[]>([]);
  const [highlightMode, setHighlightMode] = useState<HighlightMode>('background');
  const [highlightedUserColors, setHighlightedUserColors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (configModalOpen) {
      fetchGuilds();
      fetchDMChannels();
      fetchConfig();
      if (authStatus?.telegramConnected) {
        fetchTelegramChats();
      }
    }
  }, [configModalOpen, fetchGuilds, fetchDMChannels, fetchConfig, fetchTelegramChats, authStatus?.telegramConnected]);

  useEffect(() => {
    if (editingRoom) {
      setName(editingRoom.name);
      setSelectedChannels([...editingRoom.channels]);
      setHighlightedUsers([...editingRoom.highlightedUsers]);
      setFilteredUsers([...(editingRoom.filteredUsers ?? [])]);
      setFilterEnabled(editingRoom.filterEnabled ?? false);
      setRoomColor(editingRoom.color ?? '');
      setHotkey(editingRoom.hotkey ?? '');
      setRoomKeywordPatterns([...(editingRoom.keywordPatterns ?? [])]);
      setHighlightMode(editingRoom.highlightMode ?? 'background');
      setHighlightedUserColors({ ...(editingRoom.highlightedUserColors ?? {}) });
    } else {
      setName('');
      setSelectedChannels([]);
      setHighlightedUsers([]);
      setFilteredUsers([]);
      setFilterEnabled(false);
      setRoomColor('');
      setHotkey('');
      setRoomKeywordPatterns([]);
      setHighlightMode('background');
      setHighlightedUserColors({});
    }
    setSearch('');
    setNewUserId('');
    setNewFilterUser('');
    const initialTab = configModalTab && configModalTab !== 'global' ? configModalTab : 'channels';
    setTab(initialTab);
  }, [editingRoom, configModalOpen, configModalTab]);

  if (!configModalOpen || configModalTab === 'global') return null;

  const isChannelSelected = (channelId: string) =>
    selectedChannels.some((c) => c.channelId === channelId);

  const toggleChannel = (ref: ChannelRef) => {
    if (isChannelSelected(ref.channelId)) {
      setSelectedChannels((prev) => prev.filter((c) => c.channelId !== ref.channelId));
    } else {
      setSelectedChannels((prev) => [...prev, ref]);
    }
  };

  const toggleChannelEmbeds = (channelId: string) => {
    setSelectedChannels((prev) =>
      prev.map((c) =>
        c.channelId === channelId ? { ...c, disableEmbeds: !c.disableEmbeds } : c
      )
    );
  };

  // Single-add and bulk-add share `normalizeUserIdentifier`/`appendUserIdentifiers`
  // so the two paths can't normalize or dedupe differently.
  const addHighlightedUser = () => {
    const id = normalizeUserIdentifier(newUserId);
    if (!id) return;
    setHighlightedUsers((prev) => appendUserIdentifiers(prev, [id]));
    setNewUserId('');
  };

  const addHighlightedUsers = (ids: string[]) => {
    if (ids.length === 0) return;
    setHighlightedUsers((prev) => appendUserIdentifiers(prev, ids));
  };

  const removeHighlightedUser = (userId: string) => {
    setHighlightedUsers((prev) => prev.filter((u) => u !== userId));
    setHighlightedUserColors((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const addFilteredUser = () => {
    const val = normalizeUserIdentifier(newFilterUser);
    if (!val) return;
    setFilteredUsers((prev) => appendUserIdentifiers(prev, [val]));
    setNewFilterUser('');
  };

  const addFilteredUsers = (vals: string[]) => {
    if (vals.length === 0) return;
    setFilteredUsers((prev) => appendUserIdentifiers(prev, vals));
  };

  const removeFilteredUser = (user: string) => {
    setFilteredUsers((prev) => prev.filter((u) => u !== user));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editingRoom) {
        await updateRoom(editingRoom.id, { name, channels: selectedChannels, highlightedUsers, filteredUsers, filterEnabled, color: roomColor || null, keywordPatterns: roomKeywordPatterns, highlightMode, highlightedUserColors, hotkey: hotkey || null });
      } else {
        if (!name.trim()) return;
        await createRoom(name.trim(), selectedChannels, highlightedUsers, roomColor || null, filteredUsers, filterEnabled);
      }
      closeConfigModal();
    } finally {
      setSaving(false);
    }
  };

  const activeEnabledGuilds = config?.enabledGuilds ?? [];

  const filteredGuilds = guilds
    .filter((g) => activeEnabledGuilds.includes(g.id))
    .map((g) => ({
      ...g,
      channels: g.channels.filter(
        (c) => !search || c.name.toLowerCase().includes(search.toLowerCase()) || g.name.toLowerCase().includes(search.toLowerCase())
      ),
    })).filter((g) => g.channels.length > 0);

  const filteredDMs = dmChannels.filter(
    (dm) =>
      !search ||
      dm.recipients.some(
        (r) =>
          r.username.toLowerCase().includes(search.toLowerCase()) ||
          (r.global_name ?? '').toLowerCase().includes(search.toLowerCase())
      )
  );

  const filteredTelegramChats = telegramChats.filter(
    (chat) =>
      !search ||
      chat.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75" onClick={closeConfigModal}>
      <div
        className="bg-oct-surface rounded-cockpit border-2 border-oct-border shadow-oct-hard-lg w-full sm:max-w-2xl h-[90vh] sm:h-auto sm:max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b-2 border-oct-border shrink-0">
          <h2 className="font-display text-base sm:text-lg tracking-tight text-oct-text truncate">
            {editingRoom ? `Edit: ${editingRoom.name}` : 'Create New Room'}
          </h2>
          <button onClick={closeConfigModal} className="text-oct-muted hover:text-oct-accent transition-colors duration-100 shrink-0 p-1">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b-2 border-oct-border px-4 sm:px-6 shrink-0 scrollbar-none">
          <button
            onClick={() => setTab('channels')}
            className={`px-3 sm:px-4 py-2.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-[0.15em] border-b-2 transition-colors duration-100 whitespace-nowrap shrink-0 ${
              tab === 'channels'
                ? 'border-oct-accent text-oct-text'
                : 'border-transparent text-oct-muted hover:text-oct-text'
            }`}
          >
            Channels
          </button>
          <button
            onClick={() => setTab('users')}
            className={`px-3 sm:px-4 py-2.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-[0.15em] border-b-2 transition-colors duration-100 whitespace-nowrap shrink-0 ${
              tab === 'users'
                ? 'border-oct-accent text-oct-text'
                : 'border-transparent text-oct-muted hover:text-oct-text'
            }`}
          >
            Highlights
          </button>
          <button
            onClick={() => setTab('filter')}
            className={`px-3 sm:px-4 py-2.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-[0.15em] border-b-2 transition-colors duration-100 whitespace-nowrap shrink-0 ${
              tab === 'filter'
                ? 'border-oct-accent text-oct-text'
                : 'border-transparent text-oct-muted hover:text-oct-text'
            }`}
          >
            Filter
          </button>
          <button
            onClick={() => setTab('keywords')}
            className={`px-3 sm:px-4 py-2.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-[0.15em] border-b-2 transition-colors duration-100 whitespace-nowrap shrink-0 ${
              tab === 'keywords'
                ? 'border-oct-accent text-oct-text'
                : 'border-transparent text-oct-muted hover:text-oct-text'
            }`}
          >
            Keywords
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4" data-form-type="other" data-lpignore="true" data-1p-ignore>
          {tab === 'channels' && (
            <ChannelsTab
              name={name}
              setName={setName}
              roomColor={roomColor}
              setRoomColor={setRoomColor}
              hotkey={hotkey}
              setHotkey={setHotkey}
              selectedChannels={selectedChannels}
              toggleChannel={toggleChannel}
              toggleChannelEmbeds={toggleChannelEmbeds}
              isChannelSelected={isChannelSelected}
              config={config}
              updateConfig={updateConfig}
              guilds={guilds}
              dmChannels={dmChannels}
              telegramChats={telegramChats}
              authStatus={authStatus}
              platformTab={platformTab}
              setPlatformTab={setPlatformTab}
              search={search}
              setSearch={setSearch}
              filteredGuilds={filteredGuilds}
              filteredDMs={filteredDMs}
              filteredTelegramChats={filteredTelegramChats}
            />
          )}

          {tab === 'users' && (
            <UsersTab
              highlightMode={highlightMode}
              setHighlightMode={setHighlightMode}
              newUserId={newUserId}
              setNewUserId={setNewUserId}
              addHighlightedUser={addHighlightedUser}
              addHighlightedUsers={addHighlightedUsers}
              highlightedUsers={highlightedUsers}
              removeHighlightedUser={removeHighlightedUser}
              highlightedUserColors={highlightedUserColors}
              setHighlightedUserColors={setHighlightedUserColors}
              userNameMap={userNameMap}
            />
          )}

          {tab === 'filter' && (
            <FilterTab
              filterEnabled={filterEnabled}
              setFilterEnabled={setFilterEnabled}
              filteredUsers={filteredUsers}
              newFilterUser={newFilterUser}
              setNewFilterUser={setNewFilterUser}
              addFilteredUser={addFilteredUser}
              addFilteredUsers={addFilteredUsers}
              removeFilteredUser={removeFilteredUser}
              userNameMap={userNameMap}
            />
          )}

          {tab === 'keywords' && (
            <KeywordsTab
              config={config}
              updateConfig={updateConfig}
              roomKeywordPatterns={roomKeywordPatterns}
              setRoomKeywordPatterns={setRoomKeywordPatterns}
            />
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t-2 border-oct-border shrink-0">
          <button
            onClick={closeConfigModal}
            className="brutal-btn-ghost px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="brutal-btn px-4 py-2 text-sm"
          >
            {saving ? 'Saving...' : editingRoom ? 'Update Room' : 'Create Room'}
          </button>
        </div>
        {!name.trim() && (
          <p className="px-4 sm:px-6 pb-3 text-xs text-oct-muted text-right -mt-1">
            Enter a room name to continue. Channels are optional — add them on the Channels tab.
          </p>
        )}
      </div>
    </div>
  );
}
