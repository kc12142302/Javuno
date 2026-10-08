import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { collection, addDoc, query, where, getDocs, getDoc, updateDoc, deleteDoc, doc, serverTimestamp, setDoc, arrayUnion, arrayRemove, deleteField, onSnapshot } from "firebase/firestore";
import { auth, db } from "./firebase";
import AccountPage from "./AccountPages";
import "./App.css";

const initial = (email = "") => email.trim().charAt(0).toUpperCase() || "J";
const defaultLists = [{ id: "todo", name: "To Do" }, { id: "inprogress", name: "In Progress" }, { id: "done", name: "Done" }];
const ViewContext = createContext("board");
const FilterContext = createContext({});
const MemberContext = createContext([]);

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAfterDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

async function emailLookup(email) {
  const normalized = email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function taskPosition(task) {
  if (Number.isFinite(task.position)) return task.position;
  if (typeof task.createdAt?.toMillis === "function") return task.createdAt.toMillis();
  return task.createdAt?.seconds ? task.createdAt.seconds * 1000 : 0;
}

function compareTasks(left, right) {
  return taskPosition(left) - taskPosition(right) || left.id.localeCompare(right.id);
}

function savedWorkspace() {
  const stored = localStorage.getItem("javuno-active-workspace");
  if (!stored) return { id: "personal", name: "My boards" };
  try {
    const workspace = JSON.parse(stored);
    if (typeof workspace?.id === "string" && typeof workspace?.name === "string") return workspace;
  } catch {
    return { id: "personal", name: "My boards" };
  }
  return { id: "personal", name: "My boards" };
}

function showFeatureNotice(feature) {
  window.dispatchEvent(new CustomEvent("javuno:notice", { detail: `${feature} is not available yet.` }));
}

function filterTasks(tasks, filters = {}) {
  const today = dateKey(new Date());
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  return tasks.filter((task) => {
    if ((filters.archived || "active") === "active" && task.archived) return false;
    if (filters.archived === "archived" && !task.archived) return false;
    const searchText = filters.search?.trim().toLowerCase() || "";
    if (searchText && !`${task.title || ""} ${task.description || ""} ${(task.labels || []).join(" ")} ${task.assigneeEmail || ""}`.toLowerCase().includes(searchText)) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.label && !(task.labels || []).includes(filters.label)) return false;
    if (filters.assignee && task.assigneeEmail !== filters.assignee) return false;
    if (filters.due === "none" && task.dueDate) return false;
    if (filters.due === "overdue" && (!task.dueDate || task.dueDate >= today)) return false;
    if (filters.due === "week" && (!task.dueDate || task.dueDate < today || task.dueDate > dateKey(weekEnd))) return false;
    return true;
  });
}

function App() {
  const [user, setUser] = useState(null), [loading, setLoading] = useState(true);
  const [showProfile, setShowProfile] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [activePage, setActivePage] = useState("");
  const pendingCardId = useRef("");
  const [activeWorkspace, setActiveWorkspace] = useState(savedWorkspace);
  const [theme, setTheme] = useState(() => localStorage.getItem("javuno-theme") || "system");
  const [compactCards, setCompactCards] = useState(() => localStorage.getItem("javuno-compact-cards") === "true");
  const [notice, setNotice] = useState("");
  const dismissNotice = useCallback(() => setNotice(""), []);
  const [isRegistering, setIsRegistering] = useState(false), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [message, setMessage] = useState("");
  const [boards, setBoards] = useState([]), [selectedBoard, setSelectedBoard] = useState(null), [tasks, setTasks] = useState([]);
  const [boardName, setBoardName] = useState(""), [boardColor, setBoardColor] = useState("#0d8998"), [showBoardForm, setShowBoardForm] = useState(false), [search, setSearch] = useState("");
  const [taskTitle, setTaskTitle] = useState(""), [taskDescription, setTaskDescription] = useState(""), [taskDueDate, setTaskDueDate] = useState(""), [taskPriority, setTaskPriority] = useState("Medium"), [showTaskForm, setShowTaskForm] = useState(false), [editingTask, setEditingTask] = useState(null);

  useEffect(() => {
    const openProfile = () => setShowProfile(true);
    const openAppMenu = () => setShowAppMenu(true);
    const showNotice = (event) => setNotice(event.detail);
    const navigate = (event) => {
      setShowProfile(false);
      setShowAppMenu(false);
      setActivePage(event.detail);
    };
    window.addEventListener("javuno:profile", openProfile);
    window.addEventListener("javuno:app-menu", openAppMenu);
    window.addEventListener("javuno:notice", showNotice);
    window.addEventListener("javuno:navigate", navigate);
    return () => {
      window.removeEventListener("javuno:profile", openProfile);
      window.removeEventListener("javuno:app-menu", openAppMenu);
      window.removeEventListener("javuno:notice", showNotice);
      window.removeEventListener("javuno:navigate", navigate);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("javuno-theme", theme);
    document.documentElement.dataset.theme = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => {
      if (theme === "system") document.documentElement.dataset.theme = media.matches ? "dark" : "light";
    };
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("javuno-compact-cards", String(compactCards));
    document.documentElement.dataset.compactCards = String(compactCards);
  }, [compactCards]);

  useEffect(() => {
    localStorage.setItem("javuno-active-workspace", JSON.stringify(activeWorkspace));
  }, [activeWorkspace]);

  useEffect(() => {
    const handleShortcut = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "?" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("javuno:navigate", { detail: "shortcuts" }));
      } else if (event.key === "/" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        document.querySelector('input[type="search"]')?.focus();
      } else if (event.key.toLowerCase() === "b" && !event.ctrlKey && !event.metaKey && selectedBoard) {
        setActivePage("");
        setSelectedBoard(null);
        setTasks([]);
      } else if (event.key === "Escape") {
        setActivePage("");
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [selectedBoard]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setBoards([]);
      setSelectedBoard(null);
      setTasks([]);
      if (!currentUser) setActiveWorkspace({ id: "personal", name: "My boards" });
      if (currentUser) {
        try {
          await setDoc(doc(db, "profiles", currentUser.uid), { email: deleteField(), emailLookup: await emailLookup(currentUser.email || ""), updatedAt: serverTimestamp() }, { merge: true });
        } catch (error) { setMessage(error.message); }
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user?.uid) return undefined;
    let ownedBoards = [];
    let sharedBoards = [];
    const syncBoards = () => {
      const nextBoards = [...new Map([...ownedBoards, ...sharedBoards].map((board) => [board.id, board])).values()];
      setBoards(nextBoards);
      setSelectedBoard((current) => current ? nextBoards.find((board) => board.id === current.id) || null : null);
    };
    const ownedQuery = query(collection(db, "boards"), where("userId", "==", user.uid));
    const sharedQuery = query(collection(db, "boards"), where("memberIds", "array-contains", user.uid));
    const stopOwned = onSnapshot(ownedQuery, (snapshot) => {
      ownedBoards = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      syncBoards();
    }, (error) => setMessage(error.message));
    const stopShared = onSnapshot(sharedQuery, (snapshot) => {
      sharedBoards = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      syncBoards();
    }, (error) => setMessage(error.message));
    return () => { stopOwned(); stopShared(); };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return undefined;
    const ownedWorkspaces = query(collection(db, "workspaces"), where("ownerId", "==", user.uid));
    return onSnapshot(ownedWorkspaces, (snapshot) => {
      const next = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      setActiveWorkspace((current) => current.id === "personal" ? current : next.find((workspace) => workspace.id === current.id) || { id: "personal", name: "My boards" });
    }, (error) => setMessage(error.message));
  }, [user?.uid]);

  useEffect(() => {
    if (!selectedBoard?.id) return undefined;
    const tasksQuery = query(collection(db, "tasks"), where("boardId", "==", selectedBoard.id));
    return onSnapshot(tasksQuery, (snapshot) => {
      const nextTasks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(compareTasks);
      setTasks(nextTasks);
      const taskToOpen = nextTasks.find((task) => task.id === pendingCardId.current);
      if (taskToOpen) {
        pendingCardId.current = "";
        setEditingTask(taskToOpen);
      }
    }, (error) => {
      setTasks([]);
      setMessage(error.message);
      if (error.code === "permission-denied") setSelectedBoard(null);
    });
  }, [selectedBoard?.id]);

  async function handleSubmit(event) {
    event.preventDefault(); setMessage("");
    try {
      if (isRegistering) await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
      setEmail(""); setPassword("");
    } catch (error) { setMessage(getFriendlyError(error)); }
  }
  async function createBoard() {
    const name = boardName.trim(); if (!name) return;
    try {
      const members = { [user.uid]: { email: user.email, role: "owner" } };
      const workspaceId = activeWorkspace.id === "personal" ? null : activeWorkspace.id;
      const created = await addDoc(collection(db, "boards"), { name, color: boardColor, starred: false, userId: user.uid, memberIds: [user.uid], members, workspaceId, lastActivity: "Board created", createdAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
      const newBoard = { id: created.id, name, color: boardColor, starred: false, userId: user.uid, memberIds: [user.uid], members, workspaceId };
      setBoards((current) => [...new Map([...current, newBoard].map((board) => [board.id, board])).values()]);
      await recordActivity(created.id, "Board created", name);
      setBoardName(""); setShowBoardForm(false);
    } catch (error) { setMessage(error.message); }
  }
  async function deleteBoard(boardId) {
    if (!window.confirm("Are you sure you want to delete this board?")) return;
    try {
      const snapshot = await getDocs(query(collection(db, "tasks"), where("boardId", "==", boardId)));
      await Promise.all(snapshot.docs.map((task) => deleteDoc(doc(db, "tasks", task.id))));
      await deleteDoc(doc(db, "boards", boardId));
      setBoards((current) => current.filter((board) => board.id !== boardId));
    } catch (error) { setMessage(error.message); }
  }
  async function renameBoard(boardId, name) {
    const nextName = name.trim();
    if (!nextName) return;
    try {
      await updateDoc(doc(db, "boards", boardId), { name: nextName, updatedAt: serverTimestamp(), lastActivity: "Board renamed", lastActivityAt: serverTimestamp() });
      setBoards((current) => current.map((board) => board.id === boardId ? { ...board, name: nextName } : board));
      setSelectedBoard((current) => current?.id === boardId ? { ...current, name: nextName } : current);
      await recordActivity(boardId, "Board renamed", nextName);
    } catch (error) { setMessage(error.message); }
  }
  function openBoard(board) { setTasks([]); setSelectedBoard(board); }
  async function recordActivity(boardId, action, subject) {
    try {
      const entry = { action, subject, actorId: user.uid, actorEmail: user.email || "", createdAt: new Date().toISOString() };
      await updateDoc(doc(db, "boards", boardId), {
        activity: arrayUnion(entry),
        lastActivity: action,
        lastActivityAt: serverTimestamp(),
      });
    } catch (error) {
      setMessage(`The change was saved, but activity could not be recorded: ${error.message}`);
    }
  }
  function selectWorkspace(workspace) {
    setActiveWorkspace(workspace);
    setActivePage("");
    setSelectedBoard(null);
    setTasks([]);
  }
  async function toggleBoardStar(board) { const starred = !board.starred; try { await updateDoc(doc(db, "boards", board.id), { starred }); setBoards(current => current.map(item => item.id === board.id ? { ...item, starred } : item)); setSelectedBoard(current => current?.id === board.id ? { ...current, starred } : current); } catch (error) { setMessage(error.message); } }
  async function inviteMember(inviteEmail, role) {
    const normalized = inviteEmail.trim().toLowerCase(); if (!normalized) return;
    try {
      const matches = await getDocs(query(collection(db, "profiles"), where("emailLookup", "==", await emailLookup(normalized))));
      if (matches.empty) { setMessage("That person needs to create a Javuno account first."); return; }
      const member = matches.docs[0], memberId = member.id;
      const members = { ...(selectedBoard.members || {}), [memberId]: { email: normalized, role } };
      await updateDoc(doc(db, "boards", selectedBoard.id), { memberIds: arrayUnion(memberId), members, updatedAt: serverTimestamp(), lastActivity: "Member invited", lastActivityAt: serverTimestamp() });
      const next = { ...selectedBoard, memberIds: [...new Set([...(selectedBoard.memberIds || [selectedBoard.userId]), memberId])], members };
      setSelectedBoard(next); setBoards(current => current.map(b => b.id === next.id ? next : b));
      await recordActivity(selectedBoard.id, "Member invited", normalized);
    } catch (error) { setMessage(error.message); }
  }
  async function removeMember(memberId) {
    if (selectedBoard.userId !== user.uid || memberId === user.uid) return;
    try {
      await updateDoc(doc(db, "boards", selectedBoard.id), { memberIds: arrayRemove(memberId), [`members.${memberId}`]: deleteField(), updatedAt: serverTimestamp(), lastActivity: "Member removed", lastActivityAt: serverTimestamp() });
      const members = { ...selectedBoard.members };
      delete members[memberId];
      const next = { ...selectedBoard, memberIds: (selectedBoard.memberIds || []).filter((id) => id !== memberId), members };
      setSelectedBoard(next);
      setBoards((current) => current.map((board) => board.id === next.id ? next : board));
      await recordActivity(selectedBoard.id, "Member removed", selectedBoard.members?.[memberId]?.email || "Member");
    } catch (error) { setMessage(error.message); }
  }
  function resetTaskForm() { setTaskTitle(""); setTaskDescription(""); setTaskDueDate(""); setTaskPriority("Medium"); setShowTaskForm(false); }
  async function createTask(status = "todo", draft = {}) {
    const title = (draft.title || taskTitle).trim(); if (!title) return;
    try {
      const data = { title, description: (draft.description ?? taskDescription).trim(), dueDate: draft.dueDate || taskDueDate, priority: draft.priority || taskPriority, labels: draft.labels || [], assigneeId: draft.assigneeId || "", assigneeEmail: draft.assigneeEmail || "", checklist: draft.checklist || [], comments: draft.comments || [], attachments: draft.attachments || [], archived: false, position: Date.now() + tasks.filter((task) => task.status === status).length, boardId: selectedBoard.id, userId: user.uid, status, lastActivity: "Card created", lastActivityAt: serverTimestamp() };
      const created = await addDoc(collection(db, "tasks"), { ...data, createdAt: serverTimestamp() });
      await recordActivity(selectedBoard.id, "Card created", title);
      return created.id;
    } catch (error) { setMessage(error.message); }
  }
  async function saveTaskEdit(updatedTask = editingTask) {
    if (!updatedTask?.title.trim()) return;
    const update = { title: updatedTask.title.trim(), description: updatedTask.description || "", dueDate: updatedTask.dueDate || "", priority: updatedTask.priority || "Medium", labels: updatedTask.labels || [], assigneeId: updatedTask.assigneeId || "", assigneeEmail: updatedTask.assigneeEmail || "", checklist: updatedTask.checklist || [], comments: updatedTask.comments || [], attachments: updatedTask.attachments || [], updatedAt: serverTimestamp(), lastActivity: "Card updated", lastActivityAt: serverTimestamp() };
    try { await updateDoc(doc(db, "tasks", updatedTask.id), update); setTasks((current) => current.map((task) => task.id === updatedTask.id ? { ...task, ...update } : task)); await recordActivity(selectedBoard.id, "Card updated", update.title); setEditingTask(null); } catch (error) { setMessage(error.message); }
  }
  async function moveTask(taskId, status, targetTaskId) {
    const destination = tasks.filter((task) => task.status === status && task.id !== taskId).sort(compareTasks);
    const requestedIndex = targetTaskId ? destination.findIndex((task) => task.id === targetTaskId) : destination.length;
    const insertIndex = requestedIndex < 0 ? destination.length : requestedIndex;
    const before = destination[insertIndex - 1];
    const after = destination[insertIndex];
    const position = before && after ? (taskPosition(before) + taskPosition(after)) / 2 : before ? taskPosition(before) + 1000 : after ? taskPosition(after) - 1000 : Date.now();
    try {
      await updateDoc(doc(db, "tasks", taskId), { status, position, updatedAt: serverTimestamp(), lastActivity: "Card moved", lastActivityAt: serverTimestamp() });
      setTasks((current) => current.map((task) => task.id === taskId ? { ...task, status, position } : task).sort(compareTasks));
      await recordActivity(selectedBoard.id, "Card moved", tasks.find((task) => task.id === taskId)?.title || "Card");
    } catch (error) { setMessage(error.message); }
  }
  async function deleteTask(taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const archived = !task.archived;
    if (!window.confirm(archived ? "Archive this card? You can restore it later." : "Restore this card to the board?")) return;
    try {
      await updateDoc(doc(db, "tasks", taskId), { archived, archivedAt: archived ? serverTimestamp() : deleteField(), updatedAt: serverTimestamp(), lastActivity: archived ? "Card archived" : "Card restored", lastActivityAt: serverTimestamp() });
      setTasks((current) => current.map((item) => item.id === taskId ? { ...item, archived } : item));
      await recordActivity(selectedBoard.id, archived ? "Card archived" : "Card restored", task.title);
    } catch (error) { setMessage(error.message); }
  }
  async function handleLogout() { await signOut(auth); setSelectedBoard(null); setTasks([]); setBoards([]); }

  const noticeHost = notice && <NoticeHost message={notice} onClose={dismissNotice} />;
  if (loading) return <>{noticeHost}<div className="loading-screen"><div className="loading-box"><h1>Javuno</h1><p>Loading your workspace…</p></div></div></>;
  if (!user) return <>{noticeHost}<Login {...{ isRegistering, setIsRegistering, email, setEmail, password, setPassword, message, handleSubmit }} /></>;
  if (activePage) return <>{noticeHost}<AccountPage page={activePage} user={user} boards={boards} onClose={() => setActivePage("")} onOpenBoard={(boardId, cardId) => { const board = boards.find((item) => item.id === boardId); if (!board) return; pendingCardId.current = cardId; openBoard(board); }} theme={theme} onThemeChange={setTheme} compactCards={compactCards} onCompactCardsChange={setCompactCards} selectedWorkspace={activeWorkspace} onWorkspaceSelect={selectWorkspace} onWorkspaceCreated={setActiveWorkspace} /></>;
  if (showProfile) return <>{noticeHost}<ProfilePage user={user} onClose={() => setShowProfile(false)} onOpenBoards={() => { setShowProfile(false); setSelectedBoard(null); setTasks([]); }} /></>;
  if (showAppMenu) return <>{noticeHost}<AppMenu user={user} onClose={() => setShowAppMenu(false)} onHome={() => { setShowAppMenu(false); setSelectedBoard(null); setTasks([]); }} /></>;

  const workspaceBoards = boards.filter((board) => (board.workspaceId === activeWorkspace.id || (!board.workspaceId && activeWorkspace.id === "personal") || (board.memberIds || []).includes(user.uid)));
  const filteredBoards = workspaceBoards.filter((board) => board.name.toLowerCase().includes(search.toLowerCase()));
  if (selectedBoard) return <>{noticeHost}<BoardView {...{ user, selectedBoard, tasks, message, setMessage, setBoards, handleLogout, setSelectedBoard, setTasks, showTaskForm, setShowTaskForm, resetTaskForm, taskTitle, setTaskTitle, taskDescription, setTaskDescription, setTaskDueDate, taskDueDate, taskPriority, setTaskPriority, createTask, editingTask, setEditingTask, saveTaskEdit, moveTask, deleteTask, inviteMember, removeMember, recordActivity, workspaceName: activeWorkspace.name }} /></>;
  return <>{noticeHost}<Dashboard {...{ user, boards: filteredBoards, allBoards: workspaceBoards, workspaceName: activeWorkspace.name, search, setSearch, message, showBoardForm, setShowBoardForm, boardName, setBoardName, boardColor, setBoardColor, createBoard, openBoard, deleteBoard, renameBoard, toggleBoardStar, handleLogout }} /></>;
}

function AppMenu({ user, onClose, onHome }) {
  const apps = [
    ["⚡", "Jira Service Management", "Collaborative IT service management", "#ffd84d", "https://www.atlassian.com/software/jira/service-management"],
    ["↗", "Jira", "Project and issue tracking", "#2684ff", "https://www.atlassian.com/software/jira"],
    ["✦", "Confluence", "Document collaboration", "#1868db", "https://www.atlassian.com/software/confluence"],
  ];
  return <div className="app-switcher-layer" onClick={(event) => event.target === event.currentTarget && onClose()}><div className="app-switcher"><button className="app-switcher-close" onClick={onClose} aria-label="Close app menu">×</button><button className="app-switcher-item app-switcher-home" onClick={onHome}><span className="app-switcher-icon home">⌂</span><span>Home</span></button><button className="app-switcher-item app-switcher-current" onClick={onClose}><span className="app-switcher-icon javuno">●</span><span>Javuno</span></button><div className="app-switcher-divider" /><h3>Recommended for your team</h3>{apps.map(([icon, name, description, color, url]) => <a className="app-switcher-item recommended" key={name} href={url} target="_blank" rel="noreferrer"><span className="app-switcher-icon" style={{ background: color }}>{icon}</span><span><b>{name}</b><small>{description}</small></span><strong>↗</strong></a>)}<a className="app-switcher-item more-apps" href="https://www.atlassian.com/software" target="_blank" rel="noreferrer"><span className="app-switcher-icon more">▦</span><span>More Atlassian apps</span></a><div className="app-switcher-spacer" /><span className="app-switcher-user">{initial(user.email)} &nbsp; {user.email}</span></div></div>;
}
function NoticeHost({ message, onClose }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(onClose, 5000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  if (!message) return null;
  return <div className="feature-notice" role="status">{message}<button onClick={onClose} aria-label="Dismiss message">×</button></div>;
}
function Header({ user, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeMenu = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    const openAppMenu = (event) => { if (event.target.closest(".topbar-left")) window.dispatchEvent(new Event("javuno:app-menu")); };
    document.addEventListener("click", openAppMenu);
    return () => document.removeEventListener("click", openAppMenu);
  }, []);

  const navigate = (page) => {
    setMenuOpen(false);
    window.dispatchEvent(new CustomEvent("javuno:navigate", { detail: page }));
  };
  const profile = () => {
    setMenuOpen(false);
    window.dispatchEvent(new Event("javuno:profile"));
  };
  return <header className="topbar">
    <div className="topbar-left"><div className="brand"><i className="brand-mark" />Javuno</div><span className="nav-item active">Boards</span></div>
    <div className="topbar-right">
      <button className="topbar-action" onClick={() => showFeatureNotice("Feedback")}>✦ Share your thoughts</button>
      <button className="topbar-action topbar-icon-action" aria-label="Workspace menu" onClick={() => navigate("workspace")}>♧</button>
      <button className="topbar-action topbar-icon-action" aria-label="Help" onClick={() => navigate("help")}>?</button>
      <div className="profile-menu" ref={menuRef}>
        <button className="user-chip" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><i className="avatar">{initial(user.email)}</i><span>{user.email.split("@")[0]}</span><span className="profile-chevron" aria-hidden="true">⌄</span></button>
        {menuOpen && <div className="account-menu" role="menu">
          <div className="account-section-label">ACCOUNT</div>
          <div className="account-identity"><i className="avatar">{initial(user.email)}</i><div><strong>{user.email.split("@")[0]}</strong><span>{user.email}</span></div></div>
          <button role="menuitem" onClick={onLogout}>Switch account</button>
          <a role="menuitem" href="https://myaccount.google.com/" target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Manage account <span aria-hidden="true">↗</span></a>
          <div className="account-divider" /><div className="account-section-label">JAVUNO</div>
          <button role="menuitem" onClick={profile}>Profile and visibility</button>
          <button role="menuitem" onClick={() => navigate("activity")}>Activity</button>
          <button role="menuitem" onClick={() => navigate("cards")}>Cards</button>
          <button role="menuitem" onClick={() => navigate("settings")}>Settings</button>
          <button role="menuitem" onClick={() => navigate("ai-settings")}>AI Settings</button>
          <button role="menuitem" onClick={() => navigate("labs")}>Labs <span className="labs-badge">▣ Labs</span></button>
          <button className="theme-menu-item" role="menuitem" onClick={() => navigate("theme")}><span><span className="theme-icon">◐</span> Theme</span><span aria-hidden="true">›</span></button>
          <div className="account-divider" />
          <button role="menuitem" onClick={() => navigate("workspace")}>♧ &nbsp; Create Workspace</button>
          <div className="account-divider" />
          <button role="menuitem" onClick={() => navigate("help")}>Help</button>
          <button role="menuitem" onClick={() => navigate("shortcuts")}>Shortcuts</button>
          <div className="account-divider" />
          <button className="menu-logout" role="menuitem" onClick={onLogout}>Log out</button>
        </div>}
      </div>
      <button className="logout-button" onClick={onLogout}>Log out</button>
    </div>
  </header>;
}
function ProfilePage({ user, onClose, onOpenBoards }) {
  const [username, setUsername] = useState(user.email.split("@")[0]);
  const [bio, setBio] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(true);
  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        const snapshot = await getDoc(doc(db, "profiles", user.uid));
        if (!active || !snapshot.exists()) return;
        const profile = snapshot.data();
        if (typeof profile.username === "string") setUsername(profile.username);
        if (typeof profile.bio === "string") setBio(profile.bio);
      } catch (error) {
        if (active) setMessage(error.message);
      } finally {
        if (active) setLoadingProfile(false);
      }
    }
    loadProfile();
    return () => { active = false; };
  }, [user.uid]);
  const saveProfile = async (event) => {
    event.preventDefault();
    setSaving(true); setMessage("");
    try {
      await setDoc(doc(db, "profiles", user.uid), { email: deleteField(), emailLookup: await emailLookup(user.email || ""), username: username.trim(), bio: bio.trim(), updatedAt: serverTimestamp() }, { merge: true });
      setMessage("Profile saved.");
    } catch (error) { setMessage(error.message); }
    setSaving(false);
  };
  const unavailable = (feature) => {
    const pages = { Activity: "activity", Cards: "cards", Settings: "settings", "AI Settings": "ai-settings", Labs: "labs" };
    if (pages[feature]) window.dispatchEvent(new CustomEvent("javuno:navigate", { detail: pages[feature] }));
    else showFeatureNotice(feature);
  };
  return <div className="profile-page"><aside className="profile-sidebar"><strong>Personal Settings</strong><button className="profile-nav active" disabled>◉ &nbsp; Profile and Visibility</button><button className="profile-nav" onClick={() => unavailable("Activity")}>◷ &nbsp; Activity</button><button className="profile-nav" onClick={() => unavailable("Cards")}>▤ &nbsp; Cards</button><button className="profile-nav" onClick={() => unavailable("Settings")}>⚙ &nbsp; Settings</button><button className="profile-nav" onClick={() => unavailable("AI Settings")}>◈ &nbsp; AI Settings</button><button className="profile-nav" onClick={() => unavailable("Labs")}>♧ &nbsp; Labs</button><div className="profile-sidebar-divider" /><strong>Workspace</strong><button className="profile-nav" onClick={onOpenBoards}>▣ &nbsp; Boards</button><button className="profile-nav" onClick={() => unavailable("Workspace members")}>♧ &nbsp; Members</button><button className="profile-nav" onClick={() => unavailable("Workspace settings")}>⚙ &nbsp; Settings</button><button className="profile-nav" onClick={() => unavailable("Power-Ups")}>↥ &nbsp; Power-Ups</button><button className="profile-nav" onClick={() => unavailable("Workspace export")}>⇩ &nbsp; Export</button></aside><main className="profile-main"><button className="profile-close" onClick={onClose} aria-label="Close profile">×</button><div className="profile-content"><h1>Profile and Visibility</h1><div className="profile-banner"><span>✦</span><span>◈</span><span>▣</span><i className="profile-banner-avatar">{initial(user.email)}</i></div><h2>Manage your personal information</h2><p className="profile-info">Edit your personal information and visibility settings for your Javuno account.</p><form className="profile-form" onSubmit={saveProfile}><h3>About</h3><p>Required fields are marked with an asterisk<span className="required">*</span></p><label>Username<span className="required">*</span><input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><small>Always public. Visible to anyone who can access your workspace.</small><label>Bio<textarea value={bio} onChange={(event) => setBio(event.target.value)} /></label><small>Share a short description about yourself.</small><div className="profile-save-row">{message && <span className="profile-message">{message}</span>}{loadingProfile && <span className="profile-message">Loading profile…</span>}<button className="primary-button" type="submit" disabled={saving || loadingProfile}>{saving ? "Saving..." : "Save"}</button></div></form></div></main></div>;
}
function Login({ isRegistering, setIsRegistering, email, setEmail, password, setPassword, message, handleSubmit }) { return <div className="login-container"><div className="login-box"><div className="login-brand"><i className="brand-mark" />Javuno</div><p className="login-subtitle">A simple place for your projects and tasks.</p><form onSubmit={handleSubmit}><label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button className="primary-button" type="submit">{isRegistering ? "Create account" : "Log in"}</button></form>{message && <div className="error-message">{message}</div>}<button className="switch-button" onClick={() => { setIsRegistering(!isRegistering); }}>{isRegistering ? "Already have an account? Log in" : "New here? Create one"}</button></div></div>; }
function WorkspaceBar({ viewMode = "board", onViewChange, filters, onFiltersChange, tasks, title = "My Javuno Boards" }) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsRef = useRef(null);
  useEffect(() => {
    if (!viewsOpen) return undefined;
    const closeViews = (event) => { if (!viewsRef.current?.contains(event.target)) setViewsOpen(false); };
    const closeOnEscape = (event) => { if (event.key === "Escape") setViewsOpen(false); };
    document.addEventListener("pointerdown", closeViews);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeViews);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [viewsOpen]);
  const views = [["▥", "Board"], ["▤", "Table"], ["▦", "Calendar"], ["◉", "Dashboard"]];
  const labels = [...new Set(tasks.flatMap((task) => task.labels || []))].sort();
  const assignees = [...new Set(tasks.map((task) => task.assigneeEmail).filter(Boolean))].sort();
  const updateFilter = (key, value) => onFiltersChange((current) => ({ ...current, [key]: value }));
  return <div className="workspace-bar"><div className="workspace-title">{title}</div><div className="board-filter-controls"><input type="search" value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Search cards" aria-label="Search cards" /><select value={filters.priority} onChange={(event) => updateFilter("priority", event.target.value)} aria-label="Filter by priority"><option value="">All priorities</option><option>High</option><option>Medium</option><option>Low</option></select><select value={filters.label} onChange={(event) => updateFilter("label", event.target.value)} aria-label="Filter by label"><option value="">All labels</option>{labels.map((label) => <option key={label}>{label}</option>)}</select><select value={filters.assignee} onChange={(event) => updateFilter("assignee", event.target.value)} aria-label="Filter by assignee"><option value="">All members</option>{assignees.map((assignee) => <option key={assignee}>{assignee}</option>)}</select><select value={filters.due} onChange={(event) => updateFilter("due", event.target.value)} aria-label="Filter by due date"><option value="">Any due date</option><option value="overdue">Overdue</option><option value="week">Due this week</option><option value="none">No due date</option></select><button className="filter-reset" onClick={() => onFiltersChange({ search: "", priority: "", label: "", assignee: "", due: "" })}>Clear</button></div><div className="views-control" ref={viewsRef}><button className="views-button" aria-expanded={viewsOpen} onClick={() => setViewsOpen((open) => !open)}><span className="views-icon">▥</span> {viewMode[0].toUpperCase() + viewMode.slice(1)} <span className="views-chevron">⌄</span></button>{viewsOpen && <div className="views-menu"><div className="views-menu-title">Board views <button onClick={() => setViewsOpen(false)} aria-label="Close views">×</button></div>{views.map(([icon, label]) => <button className={`view-option ${viewMode === label.toLowerCase() ? "selected" : ""}`} key={label} onClick={() => { onViewChange?.(label.toLowerCase()); setViewsOpen(false); }}><span>{icon}</span>{label}</button>)}</div>}</div></div>;
}
function Dashboard(props) { return <div className="page-with-workspace"><DashboardContent {...props} /></div>; }
function DashboardContent(props) {
  const { user, boards, allBoards, workspaceName, search, setSearch, message, showBoardForm, setShowBoardForm, boardName, setBoardName, createBoard, openBoard, deleteBoard, renameBoard, handleLogout } = props;
  return <div className="app"><Header user={user} onLogout={handleLogout} /><main className="dashboard-content"><section className="dashboard-title"><h1>Boards</h1><p>{workspaceName} · Pick a board to see its tasks.</p></section>{message && <div className="error-message">{message}</div>}<div className="board-toolbar"><label className="search-wrap"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search boards" aria-label="Search boards" /></label><button className="primary-button" onClick={() => setShowBoardForm(true)}>＋ Create board</button></div>{showBoardForm && <div className="board-create-box"><input autoFocus value={boardName} onChange={(e) => setBoardName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createBoard()} placeholder="Give your board a name" /><button className="primary-button" onClick={createBoard}>Create</button><button className="cancel-button" onClick={() => { setShowBoardForm(false); setBoardName(""); }}>Cancel</button></div>}<h2 className="your-boards-title">Your boards</h2>{allBoards.length === 0 ? <div className="empty-state"><h2>No boards yet</h2><p>Create your first board to start organizing your work.</p><button className="primary-button" onClick={() => setShowBoardForm(true)}>Create your first board</button></div> : <div className="boards-list">{boards.map((board) => <div className="board-line" key={board.id}><BoardRow board={board} openBoard={openBoard} deleteBoard={deleteBoard} renameBoard={renameBoard} /></div>)}{boards.length === 0 && <div className="empty-column">No boards match “{search}”.</div>}</div>}</main></div>;
}
function BoardRow({ board, openBoard, deleteBoard, renameBoard }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board.name);
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const cancel = () => { setName(board.name); setEditing(false); };
  const save = async () => { const nextName = name.trim(); if (!nextName) return; await renameBoard(board.id, nextName); setName(nextName); setEditing(false); };
  return <><div className="board-row" role="button" tabIndex="0" onClick={() => !editing && openBoard(board)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !editing) openBoard(board); }}><i className="board-color" /><div className="board-row-copy">{editing ? <input ref={inputRef} className="board-name-input" value={name} onChange={(event) => setName(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } if (event.key === "Escape") cancel(); }} aria-label={`Edit ${board.name}`} /> : <h3 className="editable-board-name" onClick={(event) => { event.stopPropagation(); setEditing(true); }}>{board.name}</h3>}<p>Open project board</p></div><span className="open-label">{editing ? <><button className="inline-action save-name" type="button" onClick={(event) => { event.stopPropagation(); save(); }}>Save</button><button className="inline-action" type="button" onClick={(event) => { event.stopPropagation(); cancel(); }}>Cancel</button></> : <button className="inline-action" type="button" onClick={(event) => { event.stopPropagation(); setEditing(true); }}>Edit</button>}</span></div><button className="delete-board" onClick={() => deleteBoard(board.id)}>Delete</button></>;
}
function BoardView(props) {
  const [viewMode, setViewMode] = useState("board");
  const [filters, setFilters] = useState({ search: "", priority: "", label: "", assignee: "", due: "", archived: "active" });
  useEffect(() => {
    const toggleArchived = () => setFilters((current) => ({ ...current, archived: current.archived === "archived" ? "active" : "archived" }));
    window.addEventListener("javuno:toggle-archived", toggleArchived);
    return () => window.removeEventListener("javuno:toggle-archived", toggleArchived);
  }, []);
  const members = Object.entries(props.selectedBoard.members || {}).map(([id, member]) => ({ id, ...member }));
  return <ViewContext.Provider value={viewMode}><FilterContext.Provider value={filters}><MemberContext.Provider value={members}><div className="page-with-workspace"><BoardContent key={props.selectedBoard.id} {...props} viewMode={viewMode} onViewChange={setViewMode} filters={filters} /><WorkspaceBar viewMode={viewMode} onViewChange={setViewMode} filters={filters} onFiltersChange={setFilters} tasks={props.tasks} title={props.workspaceName} /><ShareModal board={props.selectedBoard} owner={props.selectedBoard.userId === props.user.uid} onInvite={props.inviteMember} onRemoveMember={props.removeMember} />{props.message && <div className="workspace-toast" role="status">{props.message}</div>}</div></MemberContext.Provider></FilterContext.Provider></ViewContext.Provider>;
}
function BoardContent(props) {
  const viewMode = props.viewMode || "board";
  const { user, selectedBoard, tasks, message, setMessage, setBoards, handleLogout, setSelectedBoard, setTasks, showTaskForm, setShowTaskForm, resetTaskForm, taskTitle, setTaskTitle, taskDescription, setTaskDescription, taskDueDate, setTaskDueDate, taskPriority, setTaskPriority, createTask, editingTask, setEditingTask, saveTaskEdit, moveTask, deleteTask, onViewChange, recordActivity } = props;
  const [lists, setLists] = useState(() => selectedBoard.lists?.length ? selectedBoard.lists : defaultLists);
  const [newTaskList, setNewTaskList] = useState("todo");
  const [draggedList, setDraggedList] = useState(null);
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const persistLists = async (nextLists, action = "Lists updated", subject = "Board lists") => { setLists(nextLists); setSelectedBoard((current) => ({ ...current, lists: nextLists })); setBoards((current) => current.map((board) => board.id === selectedBoard.id ? { ...board, lists: nextLists } : board)); try { await updateDoc(doc(db, "boards", selectedBoard.id), { lists: nextLists, updatedAt: serverTimestamp(), lastActivity: action, lastActivityAt: serverTimestamp() }); await recordActivity(selectedBoard.id, action, subject); } catch (error) { setMessage(error.message); } };
  const renameList = (listId, name) => persistLists(lists.map((list) => list.id === listId ? { ...list, name } : list), "List renamed", name);
  const colorList = (listId, color) => persistLists(lists.map((list) => list.id === listId ? { ...list, color } : list), "List color changed", lists.find((list) => list.id === listId)?.name || "List");
  const watchList = (listId) => persistLists(lists.map((list) => list.id === listId ? { ...list, watched: !list.watched } : list), "List watch changed", lists.find((list) => list.id === listId)?.name || "List");
  const moveList = (listId, direction) => { const index = lists.findIndex((list) => list.id === listId); const requestedTarget = index + direction; const target = requestedTarget >= lists.length ? index - 1 : requestedTarget < 0 ? index + 1 : requestedTarget; if (target < 0 || target >= lists.length) return; const next = [...lists]; [next[index], next[target]] = [next[target], next[index]]; persistLists(next, "List moved", lists[index].name); };
  const copyList = async (list) => { const copy = { ...list, id: `list-${Date.now()}`, name: `${list.name} copy` }; const copiedTasks = tasks.filter((task) => task.status === list.id).map((task) => ({ ...Object.fromEntries(Object.entries(task).filter(([key]) => key !== "id")), status: copy.id, lastActivity: "Card copied", lastActivityAt: serverTimestamp() })); try { await persistLists([...lists, copy], "List copied", copy.name); await Promise.all(copiedTasks.map((task) => addDoc(collection(db, "tasks"), { ...task, createdAt: serverTimestamp() }))); } catch (error) { setMessage(error.message); } };
  const archiveList = async (listId) => { if (lists.length === 1) return; const fallback = lists.find((list) => list.id !== listId); try { await Promise.all(tasks.filter((task) => task.status === listId).map((task) => updateDoc(doc(db, "tasks", task.id), { status: fallback.id, updatedAt: serverTimestamp(), lastActivity: "Card moved after list archive", lastActivityAt: serverTimestamp() }))); setTasks((current) => current.map((task) => task.status === listId ? { ...task, status: fallback.id } : task)); await persistLists(lists.filter((list) => list.id !== listId), "List archived", lists.find((list) => list.id === listId)?.name || "List"); } catch (error) { setMessage(error.message); } };
  const addList = () => { const name = newListName.trim(); if (!name) return; persistLists([...lists, { id: `list-${Date.now()}`, name }], "List created", name); setNewListName(""); setAddingList(false); };
  const dropList = (targetId) => { if (!draggedList || draggedList === targetId) return; const next = [...lists]; const from = next.findIndex((list) => list.id === draggedList); const to = next.findIndex((list) => list.id === targetId); const [moved] = next.splice(from, 1); next.splice(to, 0, moved); persistLists(next, "List reordered", moved.name); setDraggedList(null); };
  const visibleTasks = filterTasks(tasks, props.filters);
  const taskForList = (listId) => visibleTasks.filter((task) => task.status === listId);
  const showCreateTask = (listId) => { setNewTaskList(listId); setShowTaskForm(true); };
  if (viewMode !== "board") return <div className="app"><Header user={user} onLogout={handleLogout} /><main className="board-container table-container"><button className="back-button" onClick={() => { setSelectedBoard(null); setTasks([]); }}>← All boards</button><div className="board-header"><div><div className="board-heading"><i className="board-color" /><h1>{selectedBoard.name}</h1></div><p>{tasks.length} task{tasks.length !== 1 ? "s" : ""}</p></div></div>{message && <div className="error-message">{message}</div>}<TaskTable tasks={tasks} lists={lists} onEdit={setEditingTask} onDelete={deleteTask} onAdd={() => showCreateTask(lists[0]?.id || "todo")} /></main><BoardBottomNav viewMode={viewMode} onShowBoard={() => onViewChange("board")} onSwitchBoards={() => { setSelectedBoard(null); setTasks([]); }} />{showTaskForm && <TaskModal title="Create task" task={{ title: taskTitle, description: taskDescription, dueDate: taskDueDate, priority: taskPriority }} setTask={(t) => { setTaskTitle(t.title); setTaskDescription(t.description); setTaskDueDate(t.dueDate); setTaskPriority(t.priority); }} onSave={() => createTask(newTaskList)} onClose={resetTaskForm} action="Create task" />}{editingTask && <TaskModal title="Edit task" task={editingTask} setTask={setEditingTask} onSave={saveTaskEdit} onClose={() => setEditingTask(null)} action="Save changes" />}</div>;
  return <div className="app"><Header user={user} onLogout={handleLogout} /><main className="board-container"><button className="back-button" onClick={() => { setSelectedBoard(null); setTasks([]); }}>← All boards</button><div className="board-header"><div><div className="board-heading"><i className="board-color" /><h1>{selectedBoard.name}</h1></div><p>{tasks.length} task{tasks.length !== 1 ? "s" : ""}</p></div><button className="primary-button" onClick={() => setAddingList(true)}>＋ Add another list</button></div>{message && <div className="error-message">{message}</div>}<div className="columns">{lists.map((list) => <TaskColumn key={list.id} list={list} tasks={taskForList(list.id)} onMove={moveTask} onEdit={setEditingTask} onDelete={deleteTask} onAdd={() => showCreateTask(list.id)} onRename={renameList} onColor={colorList} onWatch={watchList} onCopy={copyList} onMoveList={moveList} onArchive={archiveList} onDragStart={setDraggedList} onDrop={dropList} />)}{addingList && <div className="list-composer"><input autoFocus value={newListName} onChange={(event) => setNewListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addList(); if (event.key === "Escape") { setNewListName(""); setAddingList(false); } }} placeholder="Enter list name..." aria-label="New list name" /><div><button className="add-list-button" onClick={addList}>Add list</button><button className="cancel-list-button" onClick={() => { setNewListName(""); setAddingList(false); }} aria-label="Cancel adding list">×</button></div></div>}</div></main><BoardBottomNav viewMode={viewMode} onShowBoard={() => onViewChange("board")} onSwitchBoards={() => { setSelectedBoard(null); setTasks([]); }} />{showTaskForm && <TaskModal title="Create task" task={{ title: taskTitle, description: taskDescription, dueDate: taskDueDate, priority: taskPriority }} setTask={(t) => { setTaskTitle(t.title); setTaskDescription(t.description); setTaskDueDate(t.dueDate); setTaskPriority(t.priority); }} onSave={() => createTask(newTaskList)} onClose={resetTaskForm} action="Create task" />}{editingTask && <TaskModal title="Edit task" task={editingTask} setTask={setEditingTask} onSave={saveTaskEdit} onClose={() => setEditingTask(null)} action="Save changes" />}</div>;
}
function TaskTable({ tasks, lists, onEdit, onDelete, onAdd }) {
  const viewMode = useContext(ViewContext);
  const filters = useContext(FilterContext);
  const visibleTasks = filterTasks(tasks, filters);
  const listNames = Object.fromEntries(lists.map((list) => [list.id, list.name]));
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());

  if (viewMode === "calendar") {
    const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const offset = (firstDay.getDay() + 6) % 7;
    const calendarDays = Array.from({ length: 42 }, (_, index) => new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - offset + 1));
    const tasksByDate = visibleTasks.reduce((grouped, task) => {
      if (task.dueDate) grouped[task.dueDate] = [...(grouped[task.dueDate] || []), task];
      return grouped;
    }, {});
    return <section className="calendar-shell"><div className="calendar-heading"><div><h2>{calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2><p>Cards grouped by due date</p></div><div className="calendar-controls"><button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} aria-label="Previous month">←</button><button onClick={() => setCalendarMonth(new Date())}>Today</button><button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} aria-label="Next month">→</button><button className="primary-button" onClick={onAdd}>＋ Add card</button></div></div><div className="calendar-grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}{calendarDays.map((date) => { const key = dateKey(date); const dayTasks = tasksByDate[key] || []; return <div className={`calendar-day ${date.getMonth() !== calendarMonth.getMonth() ? "outside-month" : ""}`} key={key}><span className="calendar-date">{date.getDate()}</span>{dayTasks.slice(0, 3).map((task) => <button className={`calendar-task ${(task.priority || "medium").toLowerCase()}`} key={task.id} onClick={() => onEdit(task)} title={`${task.title} · ${listNames[task.status] || "No list"}`}>{task.title}</button>)}{dayTasks.length > 3 && <span className="calendar-more">+{dayTasks.length - 3} more</span>}</div>; })}</div></section>;
  }

  if (viewMode === "dashboard") {
    const today = dateKey(new Date());
    const overdue = visibleTasks.filter((task) => task.dueDate && task.dueDate < today);
    const completed = visibleTasks.filter((task) => task.status === "done" || lists.find((list) => list.id === task.status)?.name.toLowerCase() === "done");
    const upcoming = visibleTasks.filter((task) => task.dueDate && task.dueDate >= today).sort((left, right) => left.dueDate.localeCompare(right.dueDate)).slice(0, 8);
    const dueThisWeek = visibleTasks.filter((task) => task.dueDate && task.dueDate >= today && task.dueDate <= dateAfterDays(7));
    return <section className="board-dashboard"><div className="dashboard-metrics"><article><span>Total cards</span><strong>{visibleTasks.length}</strong></article><article><span>Completed</span><strong>{completed.length}</strong></article><article><span>Overdue</span><strong>{overdue.length}</strong></article><article><span>Due this week</span><strong>{dueThisWeek.length}</strong></article></div><div className="dashboard-panels"><section><h2>Cards by list</h2>{lists.map((list) => { const count = visibleTasks.filter((task) => task.status === list.id).length; return <div className="dashboard-list-row" key={list.id}><span>{list.name}</span><span className="dashboard-list-track"><i style={{ width: `${visibleTasks.length ? count / visibleTasks.length * 100 : 0}%` }} /></span><strong>{count}</strong></div>; })}</section><section><h2>Upcoming due dates</h2>{upcoming.length ? upcoming.map((task) => <button className="upcoming-task" key={task.id} onClick={() => onEdit(task)}><span>{task.title}</span><time>{task.dueDate}</time></button>) : <p className="dashboard-empty">No upcoming due dates.</p>}</section></div></section>;
  }

  return <section className="task-table-shell"><div className="task-table-scroll"><table className="task-table"><thead><tr><th>Card</th><th>List</th><th>Priority</th><th>Labels</th><th>Member</th><th>Due date</th><th aria-label="Actions" /></tr></thead><tbody>{visibleTasks.map((task) => <tr key={task.id} onDoubleClick={() => onEdit(task)}><td><button className="table-card-title" onClick={() => onEdit(task)}>{task.title}</button></td><td>{listNames[task.status] || "-"}</td><td><span className={`priority ${(task.priority || "medium").toLowerCase()}`}>{task.priority || "-"}</span></td><td>{(task.labels || []).join(", ") || "-"}</td><td>{task.assigneeEmail || "-"}</td><td>{task.dueDate || "-"}</td><td><button className="table-delete" onClick={() => onDelete(task.id)} aria-label={`${task.archived ? "Restore" : "Archive"} ${task.title}`}>{task.archived ? "↻" : "×"}</button></td></tr>)}</tbody></table></div>{visibleTasks.length === 0 && <div className="table-empty">No cards match the current filters.</div>}<button className="table-add" onClick={onAdd}>＋ Add card</button></section>;
}
function BoardBottomNav({ viewMode, onShowBoard, onSwitchBoards }) { return <nav className="bottom-workspace-nav" aria-label="Board actions"><button className={viewMode === "board" ? "active" : ""} onClick={onShowBoard}>▥ <span>Board</span></button><button onClick={() => window.dispatchEvent(new Event("javuno:toggle-archived"))}>▣ <span>Archived</span></button><button onClick={() => window.dispatchEvent(new Event("javuno:share-board"))}>♧ <span>Share</span></button><button onClick={onSwitchBoards}>▤ <span>All boards</span></button></nav>; }
function ShareModal({ board, owner, onInvite, onRemoveMember }) {
  const [email, setEmail] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const open = () => setIsOpen(true);
    const closeOnEscape = (event) => { if (event.key === "Escape") setIsOpen(false); };
    window.addEventListener("javuno:share-board", open);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("javuno:share-board", open);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  if (!isOpen) return null;
  const members = Object.entries(board.members || { [board.userId]: { email: "Board owner", role: "owner" } });
  return <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && setIsOpen(false)}><div className="modal"><div className="modal-header"><h2>Share board</h2><button className="close-button" onClick={() => setIsOpen(false)}>×</button></div><p>Invite Javuno users to collaborate on this board.</p><div className="member-list">{members.map(([memberId, member]) => <div className="member-row" key={memberId}><span className="member-avatar">{initial(member.email || "")}</span><span className="member-identity"><strong>{member.email}</strong><small>{member.role}</small></span>{owner && memberId !== board.userId && <button className="member-remove" onClick={() => onRemoveMember(memberId)} aria-label={`Remove ${member.email}`}>Remove</button>}</div>)}</div>{owner && <><label>Invite by email</label><div className="invite-row"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@email.com" /><button className="primary-button" onClick={() => { onInvite(email, "member"); setEmail(""); }}>Invite</button></div></>}</div></div>;
}
function TaskColumn({ list, tasks, onMove, onEdit, onDelete, onAdd, onRename, onColor, onWatch, onCopy, onMoveList, onArchive, onDragStart, onDrop }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorsOpen, setColorsOpen] = useState(false);
  const colors = ["#49c995", "#f1d322", "#ffab00", "#f56c6c", "#bf72e8", "#6398e9", "#68bdd9", "#91c744", "#dd6db4", "#9296a0"];
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setColorsOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);
  const saveName = () => { if (name.trim()) onRename(list.id, name.trim()); setEditing(false); };
  return <section className="column" style={{ borderTop: `5px solid ${list.color || "#0d8998"}` }} draggable onDragStart={() => onDragStart(list.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const taskId = event.dataTransfer.getData("task-id"); if (taskId) onMove(taskId, list.id); else onDrop(list.id); }}><div className="column-header"><span className="list-drag-handle" aria-hidden="true">⋮⋮</span>{editing ? <input autoFocus className="list-name-input" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveName(); if (event.key === "Escape") { setName(list.name); setEditing(false); } }} /> : <h2 onClick={() => setEditing(true)}>{list.name}</h2>}<span className="task-count">{tasks.length}</span><button className="list-menu-button" onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); setColorsOpen(false); }} aria-label={`Open actions for ${list.name}`}>•••</button>{menuOpen && <div className="list-actions-menu"><div className="list-actions-title">List actions <button onClick={() => setMenuOpen(false)} aria-label="Close list actions">×</button></div><button onClick={() => { onAdd(); setMenuOpen(false); }}>Add card</button><button onClick={() => { onCopy(list); setMenuOpen(false); }}>Copy list</button><button onClick={() => { onMoveList(list.id, 1); setMenuOpen(false); }}>Move list</button><button onClick={() => { onWatch(list.id); setMenuOpen(false); }}>{list.watched ? "Unwatch" : "Watch"}</button><div className="list-action-divider" /><button className="color-toggle" onClick={() => setColorsOpen((open) => !open)}>Change list color <strong>PREMIUM</strong><span>{colorsOpen ? "⌃" : "⌄"}</span></button>{colorsOpen && <div className="list-colors">{colors.map((color) => <button key={color} aria-label={`Use ${color}`} style={{ background: color }} onClick={() => { onColor(list.id, color); setMenuOpen(false); setColorsOpen(false); }} />)}</div>}<div className="list-action-divider" /><button onClick={() => { onArchive(list.id); setMenuOpen(false); }}>Archive this list</button></div>}</div>{tasks.length === 0 && <p className="empty-column">No tasks waiting. Add one to get started.</p>}{tasks.map((task) => <TaskCard key={task.id} {...{ task, status: list.id, onMove, onEdit, onDelete }} />)}<button className="add-card" onClick={onAdd}>＋ Add a card</button></section>;
}
function TaskCard({ task, status, onMove, onEdit, onDelete }) { const checklist = task.checklist || []; const completed = checklist.filter((item) => item.done).length; return <article className={`task-card ${task.archived ? "archived" : ""}`} draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData("task-id", task.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); const taskId = event.dataTransfer.getData("task-id"); if (taskId) onMove(taskId, status, task.id); }}><div className="task-labels">{(task.labels || []).map((label) => <span className="task-label" key={label}>{label}</span>)}</div><h3><button type="button" className="task-title-button" onClick={() => onEdit(task)}>{task.title}</button></h3>{task.description && <p className="task-description">{task.description}</p>}<div className="task-meta"><span className={`priority ${(task.priority || "medium").toLowerCase()}`}>● {task.priority || "Medium"}</span>{task.dueDate && <span>◫ {task.dueDate}</span>}{task.assigneeEmail && <span className="task-assignee">{task.assigneeEmail}</span>}{checklist.length > 0 && <span>{completed}/{checklist.length} checklist</span>}{task.comments?.length > 0 && <span>{task.comments.length} comments</span>}{task.attachments?.length > 0 && <span>{task.attachments.length} links</span>}</div><div className="task-actions"><button onClick={() => onEdit(task)}>Edit</button><button className="danger-button" onClick={() => onDelete(task.id)}>{task.archived ? "Restore" : "Archive"}</button></div></article>; }
function TaskModal({ title, task, setTask, onSave, onClose, action }) {
  const [draft, setDraft] = useState(() => ({ ...task, labels: task.labels || [], checklist: task.checklist || [], comments: task.comments || [], attachments: task.attachments || [] }));
  const [checklistText, setChecklistText] = useState("");
  const [commentText, setCommentText] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [saveError, setSaveError] = useState("");
  const [createdTaskId, setCreatedTaskId] = useState("");
  const members = useContext(MemberContext);
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const changeMany = (changes) => { const next = { ...draft, ...changes }; setDraft(next); setTask(next); };
  const change = (key, value) => changeMany({ [key]: value });
  const updateChecklistItem = (index, done) => change("checklist", draft.checklist.map((item, itemIndex) => itemIndex === index ? { ...item, done } : item));
  const addChecklistItem = () => { const text = checklistText.trim(); if (!text) return; change("checklist", [...draft.checklist, { text, done: false }]); setChecklistText(""); };
  const addComment = () => { const text = commentText.trim(); if (!text) return; change("comments", [...draft.comments, { text, author: auth.currentUser?.email || "Javuno member", createdAt: new Date().toISOString() }]); setCommentText(""); };
  const addAttachment = () => {
    try {
      const url = new URL(attachmentUrl.trim());
      if (!["http:", "https:"].includes(url.protocol)) {
        setSaveError("Enter a valid http or https link.");
        return;
      }
      change("attachments", [...draft.attachments, { url: url.href, name: url.hostname }]);
      setAttachmentUrl("");
    } catch { setSaveError("Enter a valid http or https link."); }
  };
  const removeChecklistItem = (index) => change("checklist", draft.checklist.filter((_, itemIndex) => itemIndex !== index));
  const removeComment = (index) => change("comments", draft.comments.filter((_, commentIndex) => commentIndex !== index));
  const save = async () => {
    if (!draft.title?.trim()) return;
    setSaveError("");
    setTask({ ...draft });
    try {
      if (task.id) { await onSave(draft); return; }
      const taskId = createdTaskId || await onSave(draft);
      if (!taskId) return;
      setCreatedTaskId(taskId);
      await updateDoc(doc(db, "tasks", taskId), { title: draft.title.trim(), description: draft.description || "", dueDate: draft.dueDate || "", priority: draft.priority || "Medium", labels: draft.labels, assigneeId: draft.assigneeId || "", assigneeEmail: draft.assigneeEmail || "", checklist: draft.checklist, comments: draft.comments, attachments: draft.attachments, updatedAt: serverTimestamp() });
      onClose();
    } catch (error) { setSaveError(error.message); }
  };
  return <div className="modal-overlay"><div className="modal task-detail-modal"><div className="modal-header"><h2>{title}</h2><button className="close-button" onClick={onClose} aria-label="Close card details">×</button></div><label>Title</label><input autoFocus value={draft.title || ""} onChange={(event) => change("title", event.target.value)} placeholder="Task title" /><label>Description</label><textarea value={draft.description || ""} onChange={(event) => change("description", event.target.value)} placeholder="Description" /><div className="task-fields-row"><label>Due date<input type="date" value={draft.dueDate || ""} onChange={(event) => change("dueDate", event.target.value)} /></label><label>Priority<select value={draft.priority || "Medium"} onChange={(event) => change("priority", event.target.value)}><option>Low</option><option>Medium</option><option>High</option></select></label></div><label>Labels<input value={draft.labels.join(", ")} onChange={(event) => change("labels", event.target.value.split(",").map((label) => label.trim()).filter(Boolean))} placeholder="Design, Urgent, Research" /></label><label>Assigned member<select value={draft.assigneeId || members.find((member) => member.email === draft.assigneeEmail)?.id || ""} onChange={(event) => { const member = members.find((item) => item.id === event.target.value); changeMany({ assigneeId: member?.id || "", assigneeEmail: member?.email || "" }); }}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}</select></label><section className="task-detail-section"><h3>Checklist</h3>{draft.checklist.map((item, index) => <div className="checklist-row" key={`${item.text}-${index}`}><label><input type="checkbox" checked={Boolean(item.done)} onChange={(event) => updateChecklistItem(index, event.target.checked)} /><span>{item.text}</span></label><button type="button" onClick={() => removeChecklistItem(index)} aria-label={`Remove ${item.text}`}>×</button></div>)}<div className="detail-inline-form"><input value={checklistText} onChange={(event) => setChecklistText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addChecklistItem()} placeholder="Add checklist item" /><button type="button" onClick={addChecklistItem}>Add</button></div></section><section className="task-detail-section"><h3>Comments</h3>{draft.comments.map((comment, index) => <div className="task-comment" key={`${comment.createdAt}-${index}`}><strong>{comment.author}</strong><span>{comment.text}</span><button type="button" onClick={() => removeComment(index)} aria-label="Remove comment">Remove</button></div>)}<div className="detail-inline-form"><input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addComment()} placeholder="Write a comment" /><button type="button" onClick={addComment}>Comment</button></div></section><section className="task-detail-section"><h3>Attachments</h3>{draft.attachments.map((attachment, index) => <div className="attachment-row" key={`${attachment.url}-${index}`}><a href={attachment.url} target="_blank" rel="noreferrer">{attachment.name || attachment.url}</a><button type="button" onClick={() => change("attachments", draft.attachments.filter((_, attachmentIndex) => attachmentIndex !== index))} aria-label={`Remove ${attachment.name || attachment.url}`}>Remove</button></div>)}<div className="detail-inline-form"><input type="url" value={attachmentUrl} onChange={(event) => setAttachmentUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addAttachment()} placeholder="https://example.com/document" /><button type="button" onClick={addAttachment}>Attach link</button></div></section>{saveError && <p className="error-message" role="alert">{saveError}</p>}<button className="primary-button" onClick={save}>{action}</button></div></div>;
}
function getFriendlyError(error) { const messages = { "auth/invalid-credential": "Incorrect email or password.", "auth/email-already-in-use": "This email is already registered.", "auth/weak-password": "Password should be at least 6 characters.", "auth/invalid-email": "Please enter a valid email." }; return messages[error.code] || error.message; }
export default App;
