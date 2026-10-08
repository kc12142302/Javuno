import { useEffect, useState } from "react";
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { db } from "./firebase";

const pageTitles = {
  activity: "Activity",
  cards: "Cards",
  settings: "Settings",
  "ai-settings": "AI Settings",
  labs: "Labs",
  theme: "Theme",
  workspace: "Create Workspace",
  help: "Help",
  shortcuts: "Shortcuts",
};

function dateLabel(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "Date unavailable";
}

function timeValue(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

export default function AccountPage({ page, user, boards, onClose, onOpenBoard, theme, onThemeChange, compactCards, onCompactCardsChange, selectedWorkspace, onWorkspaceSelect, onWorkspaceCreated }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(page === "activity" || page === "cards");
  const [error, setError] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [workspaces, setWorkspaces] = useState([]);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [allowAiData, setAllowAiData] = useState(false);
  const [aiPreferenceLoaded, setAiPreferenceLoaded] = useState(false);
  const [savingAiPreference, setSavingAiPreference] = useState(false);
  const [aiPreferenceMessage, setAiPreferenceMessage] = useState("");
  const title = pageTitles[page] || "Javuno";

  useEffect(() => {
    if (page !== "activity" && page !== "cards") return undefined;
    let active = true;
    async function loadItems() {
      setLoading(true);
      setError("");
      try {
        const taskGroups = await Promise.all(boards.map(async (board) => {
          const snapshot = await getDocs(query(collection(db, "tasks"), where("boardId", "==", board.id)));
          return snapshot.docs.map((task) => ({ id: task.id, boardId: board.id, boardName: board.name, ...task.data() }));
        }));
        const allTasks = taskGroups.flat();
        const result = page === "cards"
          ? allTasks.filter((task) => task.assigneeId === user.uid || task.assigneeEmail?.toLowerCase() === user.email?.toLowerCase())
          : boards.flatMap((board) => {
            if (Array.isArray(board.activity) && board.activity.length) {
              return board.activity.slice(-100).map((entry, index) => ({
                id: `${board.id}-${index}-${entry.createdAt}`,
                boardId: board.id,
                boardName: board.name,
                title: entry.subject || board.name,
                activityAt: entry.createdAt,
                activityText: `${entry.actorEmail || "A member"} · ${entry.action}`,
              }));
            }
            const legacyTaskActivity = allTasks.filter((task) => task.boardId === board.id && (task.createdAt || task.updatedAt)).map((task) => ({
              ...task,
              activityAt: task.lastActivityAt || task.updatedAt || task.createdAt,
              activityText: task.lastActivity || (task.updatedAt ? "Card updated" : "Card created"),
            }));
            return [
              ...legacyTaskActivity,
              ...(board.createdAt || board.updatedAt ? [{
                id: `board-${board.id}`,
                boardId: board.id,
                boardName: board.name,
                title: board.name,
                activityAt: board.lastActivityAt || board.updatedAt || board.createdAt,
                activityText: board.lastActivity || "Board created",
              }] : []),
            ];
          });
        result.sort((left, right) => {
          return timeValue(right.activityAt || right.createdAt) - timeValue(left.activityAt || left.createdAt);
        });
        if (active) setItems(result);
      } catch (loadError) {
        if (active) setError(loadError.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadItems();
    return () => { active = false; };
  }, [page, boards, user.uid, user.email]);

  useEffect(() => {
    if (page !== "workspace") return undefined;
    let active = true;
    getDocs(query(collection(db, "workspaces"), where("ownerId", "==", user.uid)))
      .then((snapshot) => {
        if (active) setWorkspaces(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [page, user.uid, workspaceMessage]);

  useEffect(() => {
    if (page !== "ai-settings") return undefined;
    let active = true;
    getDoc(doc(db, "profiles", user.uid))
      .then((snapshot) => {
        if (active) {
          setAllowAiData(snapshot.data()?.allowAiData === true);
          setAiPreferenceLoaded(true);
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError.message);
          setAiPreferenceLoaded(true);
        }
      });
    return () => { active = false; };
  }, [page, user.uid]);

  const saveAiPreference = async () => {
    setSavingAiPreference(true);
    setAiPreferenceMessage("");
    try {
      await setDoc(doc(db, "profiles", user.uid), { allowAiData, updatedAt: serverTimestamp() }, { merge: true });
      setAiPreferenceMessage("AI data preference saved.");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSavingAiPreference(false);
    }
  };

  const createWorkspace = async (event) => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name) return;
    setSavingWorkspace(true);
    setWorkspaceMessage("");
    setError("");
    try {
      const result = await addDoc(collection(db, "workspaces"), {
        name,
        ownerId: user.uid,
        ownerEmail: user.email || "",
        memberIds: [user.uid],
        createdAt: serverTimestamp(),
      });
      setWorkspaces((current) => [...current, { id: result.id, name, ownerId: user.uid, ownerEmail: user.email || "", memberIds: [user.uid] }]);
      setWorkspaceName("");
      setWorkspaceMessage("Workspace created.");
      onWorkspaceCreated({ id: result.id, name, ownerId: user.uid, ownerEmail: user.email || "", memberIds: [user.uid] });
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSavingWorkspace(false);
    }
  };

  const deleteWorkspace = async (workspace) => {
    if (!window.confirm(`Delete the empty workspace "${workspace.name}"?`)) return;
    setError("");
    try {
      const ownedBoards = await getDocs(query(collection(db, "boards"), where("userId", "==", user.uid)));
      if (ownedBoards.docs.some((board) => board.data().workspaceId === workspace.id)) {
        setError("Move or delete this workspace's boards before deleting the workspace.");
        return;
      }
      await deleteDoc(doc(db, "workspaces", workspace.id));
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
      if (selectedWorkspace?.id === workspace.id) onWorkspaceSelect({ id: "personal", name: "My boards" });
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const content = (() => {
    if (page === "activity") return <section className="account-page-section">
      <p className="account-page-intro">Recent changes from boards you can access. The latest 100 actions per board are shown.</p>
      {loading ? <p>Loading activity…</p> : error ? <p className="error-message">{error}</p> : items.length === 0 ? <p className="account-page-empty">No activity yet.</p> : <div className="account-list">{items.map((item) => <article className="account-list-row" key={item.id}><div><strong>{item.title || "Untitled card"}</strong><span>{item.activityText} · {item.boardName}</span></div><time>{dateLabel(item.activityAt || item.createdAt)}</time></article>)}</div>}
    </section>;
    if (page === "cards") return <section className="account-page-section">
      <p className="account-page-intro">Cards assigned to your account across your Javuno boards.</p>
      {loading ? <p>Loading cards…</p> : error ? <p className="error-message">{error}</p> : items.length === 0 ? <p className="account-page-empty">No cards are assigned to you.</p> : <div className="account-list">{items.map((item) => <article className="account-list-row" key={item.id}><div><strong>{item.title || "Untitled card"}</strong><span>{item.boardName} · {item.status || "No list"} · {item.priority || "Medium"}</span></div><button className="inline-action" onClick={() => onOpenBoard(item.boardId, item.id)}>Open card</button></article>)}</div>}
    </section>;
    if (page === "settings") return <section className="account-page-section">
      <p className="account-page-intro">Choose how Javuno looks and opens for you.</p>
      <label className="account-setting-row"><span><strong>Default appearance</strong><small>Use the selected theme throughout Javuno.</small></span><select aria-label="Default appearance" value={theme} onChange={(event) => onThemeChange(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label className="account-setting-row"><span><strong>Compact cards (Labs)</strong><small>Reduce card spacing on board view.</small></span><input type="checkbox" checked={compactCards} onChange={(event) => onCompactCardsChange(event.target.checked)} /></label>
    </section>;
    if (page === "ai-settings") return <section className="account-page-section">
      <p className="account-page-intro">Control how AI features may use your workspace data.</p>
      <div className="account-info-panel"><strong>AI is not connected</strong><p>Javuno currently has no AI provider. No card content is sent to an AI service. This page is for your privacy preference only; it does not enable AI processing.</p></div>
      <label className="account-setting-row"><span><strong>Allow card data for future AI features</strong><small>This preference is saved, but no AI service currently uses it.</small></span><input type="checkbox" checked={allowAiData} disabled={!aiPreferenceLoaded} onChange={(event) => setAllowAiData(event.target.checked)} /></label>
      {aiPreferenceMessage && <p className="profile-message" role="status">{aiPreferenceMessage}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="primary-button" type="button" onClick={saveAiPreference} disabled={savingAiPreference || !aiPreferenceLoaded}>{savingAiPreference ? "Saving…" : "Save preference"}</button>
    </section>;
    if (page === "labs") return <section className="account-page-section">
      <p className="account-page-intro">Try optional Javuno experiments. You can turn them off at any time.</p>
      <label className="account-setting-row"><span><strong>Compact cards</strong><small>Use a more compact card layout on boards.</small></span><input type="checkbox" checked={compactCards} onChange={(event) => onCompactCardsChange(event.target.checked)} /></label>
      <div className="account-info-panel"><strong>More experiments coming soon</strong><p>Only experiments that have a working effect are listed here.</p></div>
    </section>;
    if (page === "theme") return <section className="account-page-section">
      <p className="account-page-intro">Choose a theme for Javuno.</p>
      <div className="theme-choice-list">{[["system", "Use system setting"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => <label className="theme-choice" key={value}><input type="radio" name="theme" value={value} checked={theme === value} onChange={() => onThemeChange(value)} /><span>{label}</span></label>)}</div>
    </section>;
    if (page === "workspace") return <section className="account-page-section">
      <p className="account-page-intro">Create a separate workspace for another team or project group. Your existing boards stay where they are.</p>
      <form className="workspace-create-form" onSubmit={createWorkspace}><label>Workspace name<input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required maxLength={80} placeholder="e.g. Marketing team" /></label><button className="primary-button" type="submit" disabled={savingWorkspace}>{savingWorkspace ? "Creating…" : "Create workspace"}</button></form>
      {workspaceMessage && <p className="profile-message" role="status">{workspaceMessage}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <h2>Your workspaces</h2>
      <div className="account-list-row"><div><strong>My boards</strong><span>Your existing personal boards</span></div><button className="inline-action" onClick={() => onWorkspaceSelect({ id: "personal", name: "My boards" })}>Open</button></div>
      {workspaces.length === 0 ? <p className="account-page-empty">No additional workspaces yet.</p> : <div className="account-list">{workspaces.map((workspace) => <article className="account-list-row" key={workspace.id}><div><strong>{workspace.name}</strong><span>Owned by you · {workspace.memberIds?.length || 1} member{(workspace.memberIds?.length || 1) === 1 ? "" : "s"}{selectedWorkspace?.id === workspace.id ? " · Current workspace" : ""}</span></div><div className="account-page-actions"><button className="inline-action" onClick={() => onWorkspaceSelect(workspace)}>{selectedWorkspace?.id === workspace.id ? "Current" : "Open"}</button><button className="inline-action danger-text" onClick={() => deleteWorkspace(workspace)}>Delete</button></div></article>)}</div>}
    </section>;
    if (page === "help") return <HelpContent />;
    if (page === "shortcuts") return <ShortcutsContent />;
    return <p className="account-page-empty">This page is not available.</p>;
  })();

  return <div className="account-page-shell"><header className="account-page-header"><div><span>Javuno</span><h1>{title}</h1></div><button className="profile-close" onClick={onClose} aria-label="Close page">×</button></header><main className="account-page-content">{content}</main></div>;
}

function HelpContent() {
  const [search, setSearch] = useState("");
  const topics = [
    ["Create a board", "From Boards, choose Create board, enter a name, and open it to add lists and cards."],
    ["Create and edit a card", "Choose Add a card in a list. Add a title, description, due date, priority, labels, member, checklist, comments, or links."],
    ["Move or archive a card", "Drag a card to another list. Use Archive on a card to hide it, then use Archived in the board action bar to restore it."],
    ["Share a board", "Open Share and invite someone using the email address linked to their Javuno account."],
    ["Filter cards", "Use the search, priority, label, member, and due-date controls above the board. Clear resets the filters."],
  ];
  const filtered = topics.filter(([title, description]) => `${title} ${description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="account-page-section"><p className="account-page-intro">Search quick guides for the main Javuno workflows.</p><input className="help-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search help" aria-label="Search help" /><div className="help-topics">{filtered.length ? filtered.map(([title, description]) => <details key={title}><summary>{title}</summary><p>{description}</p></details>) : <p className="account-page-empty">No help topics match your search.</p>}</div></section>;
}

function ShortcutsContent() {
  const shortcuts = [
    ["?", "Open keyboard shortcuts"],
    ["/", "Focus the current search field"],
    ["Escape", "Close an open dialog or menu"],
    ["B", "Return to all boards"],
  ];
  return <section className="account-page-section"><p className="account-page-intro">Keyboard shortcuts available in Javuno.</p><div className="shortcut-list">{shortcuts.map(([key, description]) => <div className="shortcut-row" key={key}><kbd>{key}</kbd><span>{description}</span></div>)}</div></section>;
}
