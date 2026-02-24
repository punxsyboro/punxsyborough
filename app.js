import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  deleteDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref,
  uploadBytes,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

if (!window.FIREBASE_CONFIG || !window.DOCUMENTS_SETTINGS) {
  throw new Error("Missing firebase-config.js values. Copy firebase-config.example.js and fill in your values.");
}

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const settings = window.DOCUMENTS_SETTINGS;
const adminEmails = new Set((settings.adminEmails || []).map((email) => email.toLowerCase()));
const configuredStorageBucket = (window.FIREBASE_CONFIG.storageBucket || "").trim();
const primaryStorageBucket = configuredStorageBucket || null;
const storageByBucket = new Map();

const publicGroupsEl = document.getElementById("publicGroups");
const adminGroupsEl = document.getElementById("adminGroups");
const adminPanelEl = document.getElementById("adminPanel");
const authStatusEl = document.getElementById("authStatus");
const signOutButton = document.getElementById("signOutButton");
const signInWithGoogleButton = document.getElementById("signInWithGoogleButton");
const addGroupFormEl = document.getElementById("addGroupForm");
const newGroupNameInput = document.getElementById("newGroupName");
const refreshButton = document.getElementById("refreshButton");

const publicGroupTemplate = document.getElementById("publicGroupTemplate");
const adminGroupTemplate = document.getElementById("adminGroupTemplate");
const adminDocumentTemplate = document.getElementById("adminDocumentTemplate");

const groupData = new Map();
let isAdminUser = false;
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function setStatus(message) {
  if (authStatusEl) {
    authStatusEl.textContent = message;
  }
}

function notify(message) {
  setStatus(message);
}

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || String(event.reason || "Unknown error");
  notify(`Error: ${reason}`);
});

function validateUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getStorageForBucket(bucketName) {
  const key = bucketName || "__default__";
  if (storageByBucket.has(key)) {
    return storageByBucket.get(key);
  }

  const storageInstance = bucketName ? getStorage(app, `gs://${bucketName}`) : getStorage(app);
  storageInstance.maxUploadRetryTime = 30_000;
  storageInstance.maxOperationRetryTime = 30_000;
  storageByBucket.set(key, storageInstance);
  return storageInstance;
}

getStorageForBucket(primaryStorageBucket);

function formatUploadError(error) {
  if (error?.code === "storage/retry-limit-exceeded") {
    return "Upload timed out reaching Cloud Storage. Verify storageBucket in firebase-config.js, deploy storage.rules, and ensure bucket CORS allows your origin.";
  }
  if (error?.code === "storage/unauthorized" || error?.code === "storage/unauthenticated") {
    return "Upload blocked by Storage rules or auth state. Confirm you are signed in as an admin and deploy storage.rules.";
  }
  if (error?.code === "storage/bucket-not-found") {
    return "Configured storage bucket was not found. Check FIREBASE_CONFIG.storageBucket.";
  }
  return error?.message || "Unknown upload error.";
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^\w.-]+/g, "_");
}

function buildDocumentStoragePath(groupId, fileName) {
  const uniqueSuffix = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `documents/${groupId}/${Date.now()}-${uniqueSuffix}-${sanitizeFileName(fileName)}`;
}

async function uploadDocumentFile(groupId, file) {
  const storagePath = buildDocumentStoragePath(groupId, file.name);
  const bucketName = primaryStorageBucket;
  const storageInstance = getStorageForBucket(bucketName);
  const fileRef = ref(storageInstance, storagePath);
  await uploadBytes(fileRef, file, { contentType: file.type || undefined });
  const url = await getDownloadURL(fileRef);
  return { storagePath, storageBucket: bucketName || null, url };
}

async function deleteStoredFile(storagePath, storageBucket = null) {
  if (!storagePath) return;
  try {
    const storageInstance = getStorageForBucket(storageBucket || primaryStorageBucket);
    await deleteObject(ref(storageInstance, storagePath));
  } catch (error) {
    if (error?.code !== "storage/object-not-found") {
      throw error;
    }
  }
}

const ORDER_STEP = 1_000;

function getSortOrderValue(index) {
  return (index + 1) * ORDER_STEP;
}

async function persistGroupSortOrder(orderedGroups) {
  await Promise.all(
    orderedGroups.map((group, index) =>
      updateDoc(doc(db, "groups", group.id), {
        sortOrder: getSortOrderValue(index),
      }),
    ),
  );
}

async function persistDocumentSortOrder(groupId, orderedDocuments) {
  await Promise.all(
    orderedDocuments.map((documentRecord, index) =>
      updateDoc(doc(db, "groups", groupId, "documents", documentRecord.id), {
        sortOrder: getSortOrderValue(index),
      }),
    ),
  );
}

let draggedGroupId = null;
let isGroupDragDirty = false;
let draggedDocumentContext = null;
let isDocumentDragDirty = false;
let lastPointerDownTarget = null;

document.addEventListener(
  "pointerdown",
  (event) => {
    lastPointerDownTarget = event.target;
  },
  true,
);

function dragOriginTarget(fallbackTarget) {
  if (lastPointerDownTarget instanceof Element) {
    return lastPointerDownTarget;
  }
  return fallbackTarget instanceof Element ? fallbackTarget : null;
}

function dragStartedFromTextBox(fallbackTarget) {
  const origin = dragOriginTarget(fallbackTarget);
  return Boolean(origin?.closest("input, textarea, select"));
}

function reorderElementWithinContainer(draggedElement, targetElement, pointerY) {
  if (!draggedElement || !targetElement || draggedElement === targetElement) {
    return false;
  }

  const targetParent = targetElement.parentElement;
  if (!targetParent || draggedElement.parentElement !== targetParent) {
    return false;
  }

  const targetBounds = targetElement.getBoundingClientRect();
  const insertAfter = pointerY > targetBounds.top + targetBounds.height / 2;
  const referenceNode = insertAfter ? targetElement.nextElementSibling : targetElement;

  if (referenceNode === draggedElement) {
    return false;
  }

  targetParent.insertBefore(draggedElement, referenceNode);
  return true;
}

function renderPublicGroups() {
  if (!publicGroupsEl || !publicGroupTemplate) {
    return;
  }

  publicGroupsEl.innerHTML = "";

  const groups = Array.from(groupData.values()).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  if (groups.length === 0) {
    publicGroupsEl.innerHTML = '<p class="empty-state">No document groups published yet.</p>';
    return;
  }

  for (const group of groups) {
    const fragment = publicGroupTemplate.content.cloneNode(true);
    fragment.querySelector(".group-title").textContent = group.name;
    const docsEl = fragment.querySelector(".documents");

    const docs = group.documents.slice().sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.title.localeCompare(b.title);
    });

    if (docs.length === 0) {
      docsEl.innerHTML = '<li class="empty-state">No documents in this group.</li>';
    } else {
      for (const docRecord of docs) {
        const li = document.createElement("li");
        li.className = "document-item";

        const link = document.createElement("a");
        link.href = docRecord.url;
        link.textContent = docRecord.title;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        li.appendChild(link);

        docsEl.appendChild(li);
      }
    }

    publicGroupsEl.appendChild(fragment);
  }
}

function renderAdminGroups() {
  if (!adminGroupsEl || !adminGroupTemplate || !adminDocumentTemplate) {
    return;
  }

  adminGroupsEl.innerHTML = "";

  if (!isAdminUser) {
    return;
  }

  const groups = Array.from(groupData.values()).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  if (groups.length === 0) {
    adminGroupsEl.innerHTML = '<p class="empty-state">Create your first group to get started.</p>';
    return;
  }

  for (const [groupIndex, group] of groups.entries()) {
    const fragment = adminGroupTemplate.content.cloneNode(true);
    const groupCard = fragment.querySelector(".admin-card");
    const groupHeader = fragment.querySelector(".group-admin-header");
    const nameInput = fragment.querySelector(".group-name-input");
    const moveGroupUpButton = fragment.querySelector(".move-group-up");
    const moveGroupDownButton = fragment.querySelector(".move-group-down");
    const saveGroupButton = fragment.querySelector(".save-group");
    const deleteGroupButton = fragment.querySelector(".delete-group");
    const addDocForm = fragment.querySelector(".add-doc-form");
    const documentsEl = fragment.querySelector(".admin-documents");

    groupCard.dataset.groupId = group.id;
    groupHeader.draggable = true;
    nameInput.value = group.name;
    moveGroupUpButton.disabled = groupIndex === 0;
    moveGroupDownButton.disabled = groupIndex === groups.length - 1;

    groupHeader.addEventListener("dragstart", (event) => {
      if (event.target !== groupHeader) {
        return;
      }
      if (dragStartedFromTextBox(event.target)) {
        event.preventDefault();
        return;
      }

      draggedGroupId = group.id;
      isGroupDragDirty = false;
      groupCard.classList.add("is-dragging");

      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", group.id);
      }
    });

    groupHeader.addEventListener("dragend", async (event) => {
      if (event.target !== groupHeader) {
        return;
      }

      groupCard.classList.remove("is-dragging");
      const isActiveDrag = draggedGroupId === group.id;
      draggedGroupId = null;

      if (!isActiveDrag || !isGroupDragDirty) {
        return;
      }

      isGroupDragDirty = false;

      const orderedGroupIds = Array.from(adminGroupsEl.querySelectorAll(".admin-card"))
        .map((card) => card.dataset.groupId)
        .filter(Boolean);
      const groupsById = new Map(groups.map((item) => [item.id, item]));
      const orderedGroups = orderedGroupIds.map((groupId) => groupsById.get(groupId)).filter(Boolean);

      if (orderedGroups.length !== groups.length) {
        notify("Unable to reorder groups. Try refreshing.");
        return;
      }

      try {
        await persistGroupSortOrder(orderedGroups);
        notify("Saved group order.");
      } catch (error) {
        notify(`Failed to save group order: ${error.message}`);
      }
    });

    groupCard.addEventListener("dragover", (event) => {
      if (!draggedGroupId || draggedGroupId === group.id) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }

      const draggedCard = adminGroupsEl.querySelector(`.admin-card[data-group-id="${draggedGroupId}"]`);
      if (!draggedCard) {
        return;
      }

      const moved = reorderElementWithinContainer(draggedCard, groupCard, event.clientY);
      if (moved) {
        isGroupDragDirty = true;
      }
    });

    groupCard.addEventListener("drop", (event) => {
      if (draggedGroupId) {
        event.preventDefault();
      }
    });

    moveGroupUpButton.addEventListener("click", async () => {
      if (groupIndex === 0) {
        return;
      }

      const reorderedGroups = groups.slice();
      const [movedGroup] = reorderedGroups.splice(groupIndex, 1);
      reorderedGroups.splice(groupIndex - 1, 0, movedGroup);
      await persistGroupSortOrder(reorderedGroups);
      notify(`Moved group up: ${group.name}`);
    });

    moveGroupDownButton.addEventListener("click", async () => {
      if (groupIndex === groups.length - 1) {
        return;
      }

      const reorderedGroups = groups.slice();
      const [movedGroup] = reorderedGroups.splice(groupIndex, 1);
      reorderedGroups.splice(groupIndex + 1, 0, movedGroup);
      await persistGroupSortOrder(reorderedGroups);
      notify(`Moved group down: ${group.name}`);
    });

    saveGroupButton.addEventListener("click", async () => {
      const newName = nameInput.value.trim();
      if (!newName) {
        notify("Group name cannot be empty.");
        return;
      }
      await updateDoc(doc(db, "groups", group.id), { name: newName });
      notify(`Saved group: ${newName}`);
    });

    deleteGroupButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete group \"${group.name}\" and all documents?`);
      if (!confirmed) {
        return;
      }

      const docsSnapshot = await getDocs(collection(db, "groups", group.id, "documents"));
      const promises = docsSnapshot.docs.map(async (docSnapshot) => {
        const data = docSnapshot.data();
        await deleteStoredFile(data.storagePath || null, data.storageBucket || null);
        await deleteDoc(doc(db, "groups", group.id, "documents", docSnapshot.id));
      });
      await Promise.all(promises);
      await deleteDoc(doc(db, "groups", group.id));
      notify(`Deleted group: ${group.name}`);
    });

    addDocForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const titleInput = addDocForm.querySelector(".doc-title-input");
      const fileInput = addDocForm.querySelector(".doc-file-input");
      const submitButton = addDocForm.querySelector('button[type="submit"]');

      const title = titleInput.value.trim();
      const file = fileInput.files?.[0] || null;

      if (!title) {
        notify("Document title is required.");
        return;
      }
      if (!file) {
        notify("Select a document file to upload.");
        return;
      }

      if (submitButton) submitButton.disabled = true;
      let uploadedStoragePath = null;
      let uploadedStorageBucket = null;
      try {
        notify(`Uploading ${file.name}...`);
        const { storagePath, storageBucket, url } = await uploadDocumentFile(group.id, file);
        uploadedStoragePath = storagePath;
        uploadedStorageBucket = storageBucket;

        await addDoc(collection(db, "groups", group.id, "documents"), {
          title,
          url,
          storagePath,
          storageBucket,
          fileName: file.name,
          sortOrder: Date.now(),
          createdAt: serverTimestamp(),
        });

        addDocForm.reset();
        notify(`Uploaded and added document to ${group.name}.`);
      } catch (error) {
        if (uploadedStoragePath) {
          try {
            await deleteStoredFile(uploadedStoragePath, uploadedStorageBucket);
          } catch (cleanupError) {
            console.error("Failed to clean up uploaded file after Firestore error:", cleanupError);
          }
        }
        notify(`Failed to upload document: ${formatUploadError(error)}`);
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });

    const docs = group.documents.slice().sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.title.localeCompare(b.title);
    });

    if (docs.length === 0) {
      documentsEl.innerHTML = '<li class="empty-state">No documents yet.</li>';
    } else {
      for (const [docIndex, docRecord] of docs.entries()) {
        const docFragment = adminDocumentTemplate.content.cloneNode(true);
        const li = docFragment.querySelector(".admin-document-item");
        const titleInput = docFragment.querySelector(".doc-title-edit");
        const urlInput = docFragment.querySelector(".doc-url-edit");
        const saveButton = docFragment.querySelector(".save-doc");
        const deleteButton = docFragment.querySelector(".delete-doc");

        li.dataset.documentId = docRecord.id;
        li.draggable = true;
        titleInput.value = docRecord.title;
        urlInput.value = docRecord.url;

        li.addEventListener("dragstart", (event) => {
          if (event.target !== li) {
            return;
          }
          if (dragStartedFromTextBox(event.target)) {
            event.preventDefault();
            return;
          }

          draggedDocumentContext = {
            groupId: group.id,
            documentId: docRecord.id,
          };
          isDocumentDragDirty = false;
          li.classList.add("is-dragging");

          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", docRecord.id);
          }
        });

        li.addEventListener("dragend", async (event) => {
          if (event.target !== li) {
            return;
          }

          li.classList.remove("is-dragging");

          const activeDrag = draggedDocumentContext;
          draggedDocumentContext = null;

          if (!activeDrag) {
            return;
          }
          if (activeDrag.groupId !== group.id || activeDrag.documentId !== docRecord.id || !isDocumentDragDirty) {
            return;
          }

          isDocumentDragDirty = false;

          const orderedDocumentIds = Array.from(documentsEl.querySelectorAll(".admin-document-item"))
            .map((documentItem) => documentItem.dataset.documentId)
            .filter(Boolean);
          const docsById = new Map(docs.map((item) => [item.id, item]));
          const orderedDocuments = orderedDocumentIds.map((documentId) => docsById.get(documentId)).filter(Boolean);

          if (orderedDocuments.length !== docs.length) {
            notify("Unable to reorder documents. Try refreshing.");
            return;
          }

          try {
            await persistDocumentSortOrder(group.id, orderedDocuments);
            notify(`Saved document order for ${group.name}.`);
          } catch (error) {
            notify(`Failed to save document order: ${error.message}`);
          }
        });

        li.addEventListener("dragover", (event) => {
          if (!draggedDocumentContext) {
            return;
          }
          if (draggedDocumentContext.groupId !== group.id || draggedDocumentContext.documentId === docRecord.id) {
            return;
          }

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }

          const draggedDoc = documentsEl.querySelector(
            `.admin-document-item[data-document-id="${draggedDocumentContext.documentId}"]`,
          );
          if (!draggedDoc) {
            return;
          }

          const moved = reorderElementWithinContainer(draggedDoc, li, event.clientY);
          if (moved) {
            isDocumentDragDirty = true;
          }
        });

        li.addEventListener("drop", (event) => {
          if (draggedDocumentContext?.groupId === group.id) {
            event.preventDefault();
          }
        });

        saveButton.addEventListener("click", async () => {
          const title = titleInput.value.trim();
          const url = urlInput.value.trim();

          if (!title) {
            notify("Document title cannot be empty.");
            return;
          }
          if (!validateUrl(url)) {
            notify("Use a valid http:// or https:// URL.");
            return;
          }

          await updateDoc(doc(db, "groups", group.id, "documents", docRecord.id), {
            title,
            url,
          });

          notify(`Saved document: ${title}`);
        });

        deleteButton.addEventListener("click", async () => {
          const confirmed = window.confirm(`Delete document \"${docRecord.title}\"?`);
          if (!confirmed) {
            return;
          }

          await deleteStoredFile(docRecord.storagePath, docRecord.storageBucket);
          await deleteDoc(doc(db, "groups", group.id, "documents", docRecord.id));
          notify(`Deleted document: ${docRecord.title}`);
        });

        documentsEl.appendChild(docFragment);
      }
    }

    adminGroupsEl.appendChild(fragment);
  }
}

function renderAll() {
  renderPublicGroups();
  renderAdminGroups();
}

function groupWithFallback(groupId) {
  if (!groupData.has(groupId)) {
    groupData.set(groupId, {
      id: groupId,
      name: "Untitled Group",
      sortOrder: Number.MAX_SAFE_INTEGER,
      documents: [],
    });
  }
  return groupData.get(groupId);
}

function subscribeToDocuments(groupId) {
  const docsQuery = query(collection(db, "groups", groupId, "documents"), orderBy("sortOrder"));
  return onSnapshot(docsQuery, (snapshot) => {
    const group = groupWithFallback(groupId);
    group.documents = snapshot.docs.map((docSnapshot) => {
      const data = docSnapshot.data();
      return {
        id: docSnapshot.id,
        title: data.title || "Untitled Document",
        url: data.url || "#",
        storagePath: data.storagePath || null,
        storageBucket: data.storageBucket || null,
        sortOrder: data.sortOrder ?? Number.MAX_SAFE_INTEGER,
      };
    });
    renderAll();
  });
}

const unsubscribeByGroup = new Map();

const groupsQuery = query(collection(db, "groups"), orderBy("sortOrder"));
onSnapshot(groupsQuery, (snapshot) => {
  const activeGroupIds = new Set();

  snapshot.docs.forEach((docSnapshot) => {
    const data = docSnapshot.data();
    const groupId = docSnapshot.id;
    activeGroupIds.add(groupId);

    const existing = groupWithFallback(groupId);
    existing.name = data.name || "Untitled Group";
    existing.sortOrder = data.sortOrder ?? Number.MAX_SAFE_INTEGER;

    if (!unsubscribeByGroup.has(groupId)) {
      unsubscribeByGroup.set(groupId, subscribeToDocuments(groupId));
    }
  });

  for (const [groupId, unsubscribe] of unsubscribeByGroup.entries()) {
    if (!activeGroupIds.has(groupId)) {
      unsubscribe();
      unsubscribeByGroup.delete(groupId);
      groupData.delete(groupId);
    }
  }

  renderAll();
});

onAuthStateChanged(auth, (user) => {
  const email = user?.email?.toLowerCase() || "";
  isAdminUser = Boolean(user && adminEmails.has(email));

  if (user && isAdminUser) {
    if (adminPanelEl) {
      adminPanelEl.classList.remove("hidden");
      adminPanelEl.setAttribute("aria-hidden", "false");
    }
    if (signOutButton) {
      signOutButton.disabled = false;
    }
    setStatus(`Signed in as ${user.email}. Admin mode enabled.`);
  } else if (user) {
    if (adminPanelEl) {
      adminPanelEl.classList.add("hidden");
      adminPanelEl.setAttribute("aria-hidden", "true");
    }
    if (signOutButton) {
      signOutButton.disabled = false;
    }
    setStatus(`Signed in as ${user.email}. This account is not an admin.`);
  } else {
    if (adminPanelEl) {
      adminPanelEl.classList.add("hidden");
      adminPanelEl.setAttribute("aria-hidden", "true");
    }
    if (signOutButton) {
      signOutButton.disabled = true;
    }
    setStatus("Not signed in.");
  }

  renderAll();
});

if (signInWithGoogleButton) {
  signInWithGoogleButton.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      notify(`Google sign in failed: ${error.message}`);
    }
  });
}

if (signOutButton) {
  signOutButton.addEventListener("click", async () => {
    await signOut(auth);
    notify("Signed out.");
  });
}

if (addGroupFormEl) {
  addGroupFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAdminUser) {
      notify("Admin login required to add groups.");
      return;
    }

    const name = newGroupNameInput?.value.trim() || "";
    if (!name) {
      notify("Group name is required.");
      return;
    }

    await addDoc(collection(db, "groups"), {
      name,
      sortOrder: Date.now(),
      createdAt: serverTimestamp(),
    });

    newGroupNameInput.value = "";
    notify(`Added group: ${name}`);
  });
}

if (refreshButton) {
  refreshButton.addEventListener("click", () => {
    renderAll();
    notify("View refreshed.");
  });
}

if (settings.seedExampleData) {
  (async () => {
    const current = await getDocs(collection(db, "groups"));
    if (current.empty) {
      const budgetsRef = await addDoc(collection(db, "groups"), {
        name: "Budgets",
        sortOrder: Date.now(),
        createdAt: serverTimestamp(),
      });

      await addDoc(collection(db, "groups", budgetsRef.id, "documents"), {
        title: "Budget 2025",
        url: "https://example.com/budget-2025.pdf",
        sortOrder: Date.now(),
        createdAt: serverTimestamp(),
      });
    }
  })();
}
