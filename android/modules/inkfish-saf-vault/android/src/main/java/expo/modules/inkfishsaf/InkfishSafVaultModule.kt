package expo.modules.inkfishsaf

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID

private data class SafEntry(
  val id: String,
  val name: String,
  val mime: String,
  val size: Long,
  val modified: Long,
  val flags: Int
) {
  val directory: Boolean get() = mime == DocumentsContract.Document.MIME_TYPE_DIR
}

class InkfishSafVaultModule : Module() {
  private val resolver: ContentResolver
    get() = requireNotNull(appContext.reactContext).contentResolver

  override fun definition() = ModuleDefinition {
    Name("InkfishSafVault")

    AsyncFunction("probe") { tree: String -> probe(tree) }
    AsyncFunction("isAvailable") { tree: String -> runCatching { requireTree(tree); true }.getOrDefault(false) }
    AsyncFunction("list") { tree: String, rel: String -> list(tree, rel) }
    AsyncFunction("stat") { tree: String, rel: String -> stat(tree, rel) }
    AsyncFunction("hash") { tree: String, rel: String -> hashPath(treeUri(tree), rel) }
    AsyncFunction("hashUri") { source: String -> digestUri(Uri.parse(source)) }
    AsyncFunction("read") { tree: String, rel: String, encoding: String ->
      val bytes = readBytes(treeUri(tree), rel)
      if (encoding == "base64") Base64.encodeToString(bytes, Base64.NO_WRAP) else String(bytes, Charsets.UTF_8)
    }
    AsyncFunction("writeAtomic") { tree: String, rel: String, contents: String, encoding: String ->
      val bytes = if (encoding == "base64") Base64.decode(contents, Base64.DEFAULT) else contents.toByteArray(Charsets.UTF_8)
      atomicWrite(treeUri(tree), rel, bytes, requireAbsent = false)
    }
    AsyncFunction("writeAtomicIfAbsent") { tree: String, rel: String, contents: String, encoding: String ->
      val bytes = if (encoding == "base64") Base64.decode(contents, Base64.DEFAULT) else contents.toByteArray(Charsets.UTF_8)
      atomicWrite(treeUri(tree), rel, bytes, requireAbsent = true)
    }
    AsyncFunction("copyFromUri") { source: String, tree: String, rel: String ->
      copyFromUri(Uri.parse(source), treeUri(tree), rel)
    }
    AsyncFunction("mkdir") { tree: String, rel: String -> mkdir(treeUri(tree), rel) }
    AsyncFunction("move") { tree: String, from: String, to: String -> move(tree, from, to) }
    AsyncFunction("delete") { tree: String, rel: String -> delete(tree, rel) }
    AsyncFunction("recover") { tree: String -> recover(tree) }
  }

  private fun treeUri(raw: String): Uri = requireTree(raw)

  private fun requireTree(raw: String): Uri {
    val uri = Uri.parse(raw)
    if (uri.scheme != "content" || !DocumentsContract.isTreeUri(uri)) {
      throw IllegalArgumentException("The selected location is not an Android document tree.")
    }
    val grant = resolver.persistedUriPermissions.firstOrNull { it.uri == uri }
    if (grant == null || !grant.isReadPermission || !grant.isWritePermission) {
      throw SecurityException("Shared-folder access was revoked. Reconnect the folder in Settings.")
    }
    // Grants can outlive moved/deleted roots; query the tree document to prove it is still reachable.
    val root = queryEntry(uri, document(uri, DocumentsContract.getTreeDocumentId(uri)))
    if (root?.directory != true) throw SecurityException("The selected shared folder is no longer available.")
    return uri
  }

  private fun document(tree: Uri, id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)

  private fun queryEntry(tree: Uri, uri: Uri): SafEntry? {
    val columns = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      OpenableColumns.DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      OpenableColumns.SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      DocumentsContract.Document.COLUMN_FLAGS
    )
    return resolver.query(uri, columns, null, null, null)?.use { c ->
      if (!c.moveToFirst()) return@use null
      fun value(column: String): Int = c.getColumnIndex(column)
      val idIndex = value(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = value(OpenableColumns.DISPLAY_NAME)
      val mimeIndex = value(DocumentsContract.Document.COLUMN_MIME_TYPE)
      val sizeIndex = value(OpenableColumns.SIZE)
      val modifiedIndex = value(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      val flagsIndex = value(DocumentsContract.Document.COLUMN_FLAGS)
      val id = if (idIndex >= 0) c.getString(idIndex) else DocumentsContract.getDocumentId(uri)
      SafEntry(
        id = id,
        name = if (nameIndex >= 0) c.getString(nameIndex) ?: "" else "",
        mime = if (mimeIndex >= 0) c.getString(mimeIndex) ?: "" else "",
        size = if (sizeIndex >= 0 && !c.isNull(sizeIndex)) c.getLong(sizeIndex) else 0L,
        modified = if (modifiedIndex >= 0 && !c.isNull(modifiedIndex)) c.getLong(modifiedIndex) else 0L,
        flags = if (flagsIndex >= 0 && !c.isNull(flagsIndex)) c.getInt(flagsIndex) else 0
      )
    }
  }

  private fun children(tree: Uri, parentId: String): List<SafEntry> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val columns = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      OpenableColumns.DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      OpenableColumns.SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      DocumentsContract.Document.COLUMN_FLAGS
    )
    return resolver.query(uri, columns, null, null, null)?.use { c ->
      val result = mutableListOf<SafEntry>()
      val idIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      val mimeIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
      val sizeIndex = c.getColumnIndex(OpenableColumns.SIZE)
      val modifiedIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      val flagsIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
      while (c.moveToNext()) {
        val id = if (idIndex >= 0) c.getString(idIndex) else continue
        result += SafEntry(
          id,
          if (nameIndex >= 0) c.getString(nameIndex) ?: "" else "",
          if (mimeIndex >= 0) c.getString(mimeIndex) ?: "" else "",
          if (sizeIndex >= 0 && !c.isNull(sizeIndex)) c.getLong(sizeIndex) else 0L,
          if (modifiedIndex >= 0 && !c.isNull(modifiedIndex)) c.getLong(modifiedIndex) else 0L,
          if (flagsIndex >= 0 && !c.isNull(flagsIndex)) c.getInt(flagsIndex) else 0
        )
      }
      result
    } ?: throw IllegalStateException("The document provider could not list this folder.")
  }

  private fun segments(rel: String): List<String> {
    val trimmed = rel.trim('/')
    if (trimmed.isEmpty()) return emptyList()
    val parts = trimmed.split('/')
    require(parts.all { it.isNotEmpty() && it != "." && it != ".." && !it.contains('\\') }) {
      "Unsafe shared-vault path."
    }
    return parts
  }

  private fun resolve(tree: Uri, rel: String): SafEntry? {
    val parts = segments(rel)
    var currentId = DocumentsContract.getTreeDocumentId(tree)
    if (parts.isEmpty()) return queryEntry(tree, document(tree, currentId))
    for ((i, part) in parts.withIndex()) {
      val matches = children(tree, currentId).filter { it.name == part }
      if (matches.size > 1) throw IllegalStateException("Ambiguous duplicate path: $rel")
      val hit = matches.firstOrNull() ?: return null
      if (i < parts.lastIndex && !hit.directory) return null
      currentId = hit.id
      if (i == parts.lastIndex) return hit
    }
    return null
  }

  private fun resolveParent(tree: Uri, parts: List<String>, create: Boolean = false): Pair<Uri, String> {
    require(parts.isNotEmpty()) { "A file name is required." }
    val name = parts.last()
    var parentId = DocumentsContract.getTreeDocumentId(tree)
    for (part in parts.dropLast(1)) {
      val hits = children(tree, parentId).filter { it.name == part }
      if (hits.size > 1) throw IllegalStateException("Ambiguous duplicate folder: $part")
      val hit = hits.firstOrNull()
      if (hit == null) {
        if (!create) throw IllegalStateException("Shared folder does not exist: $part")
        val parentUri = document(tree, parentId)
        val made = DocumentsContract.createDocument(resolver, parentUri, DocumentsContract.Document.MIME_TYPE_DIR, part)
          ?: throw IllegalStateException("The document provider could not create folder: $part")
        val entry = queryEntry(tree, made) ?: throw IllegalStateException("The new folder could not be verified: $part")
        if (entry.name != part || !entry.directory) throw IllegalStateException("The provider changed the requested folder name: $part")
        parentId = entry.id
      } else {
        if (!hit.directory) throw IllegalStateException("A file blocks this folder path: $part")
        parentId = hit.id
      }
    }
    return document(tree, parentId) to name
  }

  private fun mime(name: String): String = when {
    name.endsWith(".md", true) -> "text/markdown"
    name.endsWith(".png", true) -> "image/png"
    name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
    name.endsWith(".webp", true) -> "image/webp"
    name.endsWith(".gif", true) -> "image/gif"
    name.endsWith(".json", true) -> "application/json"
    else -> "application/octet-stream"
  }

  private fun createFile(tree: Uri, parent: Uri, name: String): Uri {
    require(name.isNotEmpty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\'))
    val made = DocumentsContract.createDocument(resolver, parent, mime(name), name)
      ?: throw IllegalStateException("The document provider could not create file: $name")
    val entry = queryEntry(tree, made) ?: throw IllegalStateException("The new file could not be verified: $name")
    if (entry.name != name || entry.directory) {
      runCatching { DocumentsContract.deleteDocument(resolver, made) }
      throw IllegalStateException("The provider changed the requested file name: $name")
    }
    return document(tree, entry.id)
  }

  private fun mkdir(tree: Uri, rel: String) {
    requireTree(tree.toString())
    val parts = segments(rel)
    var parentId = DocumentsContract.getTreeDocumentId(tree)
    for (part in parts) {
      val hits = children(tree, parentId).filter { it.name == part }
      if (hits.size > 1) throw IllegalStateException("Ambiguous duplicate folder: $part")
      val existing = hits.firstOrNull()
      if (existing != null) {
        if (!existing.directory) throw IllegalStateException("A file blocks this folder path: $part")
        parentId = existing.id
      } else {
        val made = DocumentsContract.createDocument(resolver, document(tree, parentId), DocumentsContract.Document.MIME_TYPE_DIR, part)
          ?: throw IllegalStateException("The document provider could not create folder: $part")
        val entry = queryEntry(tree, made) ?: throw IllegalStateException("The new folder could not be verified: $part")
        if (!entry.directory || entry.name != part) throw IllegalStateException("The provider changed the requested folder name: $part")
        parentId = entry.id
      }
    }
  }

  private fun list(treeRaw: String, rel: String): List<Map<String, Any>> {
    val tree = treeUri(treeRaw)
    val folder = resolve(tree, rel) ?: if (segments(rel).isEmpty()) queryEntry(tree, document(tree, DocumentsContract.getTreeDocumentId(tree))) else null
    if (folder == null || !folder.directory) throw IllegalStateException("Shared folder is unavailable: $rel")
    return children(tree, folder.id).map {
      mapOf(
        "name" to it.name,
        "isDirectory" to it.directory,
        "size" to it.size,
        "modificationTime" to it.modified,
        "uri" to document(tree, it.id).toString()
      )
    }
  }

  private fun stat(treeRaw: String, rel: String): Map<String, Any> {
    val tree = treeUri(treeRaw)
    val entry = resolve(tree, rel)
    return if (entry == null) {
      mapOf("exists" to false, "isDirectory" to false, "size" to 0, "modificationTime" to 0)
    } else {
      mapOf("exists" to true, "isDirectory" to entry.directory, "size" to entry.size, "modificationTime" to entry.modified, "uri" to document(tree, entry.id).toString())
    }
  }

  private fun readBytes(tree: Uri, rel: String): ByteArray {
    requireTree(tree.toString())
    val entry = resolve(tree, rel) ?: throw IllegalStateException("Shared file does not exist: $rel")
    if (entry.directory) throw IllegalStateException("Expected a file, found a folder: $rel")
    return resolver.openInputStream(document(tree, entry.id))?.use { input ->
      val output = ByteArrayOutputStream()
      input.copyTo(output)
      output.toByteArray()
    } ?: throw IllegalStateException("The document provider could not read: $rel")
  }

  private fun hashPath(tree: Uri, rel: String): String {
    val entry = resolve(tree, rel) ?: throw IllegalStateException("Shared file does not exist: $rel")
    if (entry.directory) throw IllegalStateException("Expected a file, found a folder: $rel")
    return digestUri(document(tree, entry.id))
  }

  private fun writeBytes(tree: Uri, file: Uri, bytes: ByteArray) {
    resolver.openOutputStream(file, "wt")?.use { it.write(bytes); it.flush() }
      ?: throw IllegalStateException("The document provider could not write the staged file.")
  }

  private fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun rename(tree: Uri, uri: Uri, newName: String): Uri {
    val renamed = DocumentsContract.renameDocument(resolver, uri, newName)
      ?: throw IllegalStateException("This document provider does not support safe rename operations.")
    val entry = queryEntry(tree, renamed) ?: throw IllegalStateException("The renamed document could not be verified.")
    if (entry.name != newName) throw IllegalStateException("The provider changed a requested name during rename.")
    return document(tree, entry.id)
  }

  private fun rollbackWrite(tree: Uri, rel: String, backup: Uri, name: String, token: String) {
    val current = resolve(tree, rel)
    if (current != null) {
      // Keep an unverified or concurrently-created replacement rather than deleting it.
      runCatching { rename(tree, document(tree, current.id), ".${name}.inkfish-failed-$token") }
    }
    if (resolve(tree, rel) == null) runCatching { rename(tree, backup, name) }
  }

  /** Stage, read-back verify, then swap names. An old version stays in a hidden backup until verification. */
  private fun atomicWrite(tree: Uri, rel: String, bytes: ByteArray, requireAbsent: Boolean) {
    requireTree(tree.toString())
    val parts = segments(rel)
    val (parent, name) = resolveParent(tree, parts, create = true)
    val existing = resolve(tree, rel)
    if (existing?.directory == true) throw IllegalStateException("A folder blocks this file path: $rel")
    if (requireAbsent && existing != null) throw IllegalStateException("A document already exists at: $rel")
    val token = UUID.randomUUID().toString()
    val tempName = ".${name}.inkfish-tmp-$token"
    val tempRel = parts.dropLast(1).plus(tempName).joinToString("/")
    val temp = createFile(tree, parent, tempName)
    var backup: Uri? = null
    try {
      writeBytes(tree, temp, bytes)
      if (digestUri(temp) != sha(bytes)) {
        throw IllegalStateException("Staged file verification failed: $rel")
      }
      if (existing != null) {
        val backupName = ".${name}.inkfish-backup-$token"
        backup = rename(tree, document(tree, existing.id), backupName)
      }
      if (requireAbsent && resolve(tree, rel) != null) throw IllegalStateException("A document appeared at the migration destination: $rel")
      rename(tree, temp, name)
      val installed = resolve(tree, rel) ?: throw IllegalStateException("The new file could not be found after install: $rel")
      if (installed.directory || digestUri(document(tree, installed.id)) != sha(bytes)) {
        throw IllegalStateException("Installed file verification failed: $rel")
      }
      // If deletion is unsupported or the provider disconnects, preserve the backup rather than fail the verified write.
      backup?.let { runCatching { DocumentsContract.deleteDocument(resolver, it) } }
    } catch (error: Exception) {
      // Restore the old version while retaining any unverified replacement under a hidden unique name.
      if (backup != null) rollbackWrite(tree, rel, backup!!, name, token)
      runCatching { resolve(tree, tempRel)?.let { deleteRecursively(tree, it) } }
      throw error
    }
  }

  private fun copyFromUri(source: Uri, tree: Uri, rel: String) {
    requireTree(tree.toString())
    val parts = segments(rel)
    val (parent, name) = resolveParent(tree, parts, create = true)
    if (resolve(tree, rel) != null) throw IllegalStateException("A document already exists at: $rel")
    val token = UUID.randomUUID().toString()
    val tempName = ".${name}.inkfish-tmp-$token"
    val tempRel = parts.dropLast(1).plus(tempName).joinToString("/")
    val temp = createFile(tree, parent, tempName)
    try {
      val sourceDigest = digestUri(source)
      val input = resolver.openInputStream(source)
        ?: throw IllegalStateException("The source attachment cannot be read.")
      val output = resolver.openOutputStream(temp, "wt")
        ?: throw IllegalStateException("The document provider could not write the staged attachment.")
      input.use { src -> output.use { dst -> src.copyTo(dst); dst.flush() } }
      if (digestUri(temp) != sourceDigest || digestUri(source) != sourceDigest) {
        throw IllegalStateException("Attachment copy verification failed: $rel")
      }
      rename(tree, temp, name)
      val installed = resolve(tree, rel)
      if (installed == null || installed.directory || digestUri(document(tree, installed.id)) != sourceDigest) {
        throw IllegalStateException("Installed attachment verification failed: $rel")
      }
    } catch (e: Exception) {
      // The source is untouched; clean only the temporary document created by this operation.
      runCatching { resolve(tree, tempRel)?.let { deleteRecursively(tree, it) } }
      throw e
    }
  }

  private fun digestStream(input: java.io.InputStream): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(128 * 1024)
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      md.update(buffer, 0, n)
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  private fun digestUri(uri: Uri): String = resolver.openInputStream(uri)?.use { digestStream(it) }
    ?: throw IllegalStateException("The document provider could not read back a staged document.")

  private fun delete(treeRaw: String, rel: String) {
    val tree = treeUri(treeRaw)
    val entry = resolve(tree, rel) ?: return
    deleteRecursively(tree, entry)
  }

  private fun deleteRecursively(tree: Uri, entry: SafEntry) {
    if (entry.directory) children(tree, entry.id).forEach { deleteRecursively(tree, it) }
    if (!DocumentsContract.deleteDocument(resolver, document(tree, entry.id))) {
      throw IllegalStateException("The provider refused to delete: ${entry.name}")
    }
  }

  private fun copyEntry(tree: Uri, source: SafEntry, destRel: String) {
    if (source.directory) {
      mkdir(tree, destRel)
      for (child in children(tree, source.id)) copyEntry(tree, child, "$destRel/${child.name}")
    } else {
      copyFromUri(document(tree, source.id), tree, destRel)
    }
  }

  private fun move(treeRaw: String, from: String, to: String) {
    val tree = treeUri(treeRaw)
    val source = resolve(tree, from) ?: return
    if (resolve(tree, to) != null) throw IllegalStateException("Move destination already exists: $to")
    val parts = segments(to)
    val (parent, targetName) = resolveParent(tree, parts, create = true)
    val sourceUri = document(tree, source.id)
    val targetParentId = DocumentsContract.getDocumentId(parent)
    val sourceParentId = if (segments(from).isEmpty()) "" else {
      val srcParts = segments(from)
      resolve(tree, srcParts.dropLast(1).joinToString("/"))?.id ?: DocumentsContract.getTreeDocumentId(tree)
    }
    if (targetName == source.name && targetParentId == sourceParentId) return
    if (targetParentId == sourceParentId) {
      val movedUri = runCatching { DocumentsContract.renameDocument(resolver, sourceUri, targetName) }.getOrNull()
      if (movedUri != null) {
        val moved = queryEntry(tree, movedUri)
        if (moved?.name == targetName) return
      }
    } else {
      val oldParent = document(tree, sourceParentId)
      val nativeMove = runCatching { DocumentsContract.moveDocument(resolver, sourceUri, oldParent, parent) }.getOrNull()
      if (nativeMove != null) {
        val finalUri = if (source.name == targetName) nativeMove else runCatching { DocumentsContract.renameDocument(resolver, nativeMove, targetName) }.getOrNull()
        val movedEntry = finalUri?.let { queryEntry(tree, it) }
        if (movedEntry?.name == targetName) return
      }
    }
    // Provider lacks native move: copy and verify everything before deleting any source entries.
    copyEntry(tree, source, to)
    deleteRecursively(tree, source)
  }

  private fun walk(tree: Uri, id: String): Sequence<Pair<String, SafEntry>> = sequence {
    for (entry in children(tree, id)) {
      yield(entry.name to entry)
      if (entry.directory) for ((relative, nested) in walk(tree, entry.id)) yield("${entry.name}/$relative" to nested)
    }
  }

  private fun recover(treeRaw: String): Int {
    val tree = treeUri(treeRaw)
    var restored = 0
    val pending = ArrayDeque<Pair<String, String>>()
    pending.addLast("" to DocumentsContract.getTreeDocumentId(tree))
    while (pending.isNotEmpty()) {
      val (rel, id) = pending.removeFirst()
      for (entry in children(tree, id)) {
        val path = if (rel.isEmpty()) entry.name else "$rel/${entry.name}"
        if (entry.directory) pending.addLast(path to entry.id)
        val match = Regex("^\\.(.+)\\.inkfish-backup-[0-9a-f-]+$").matchEntire(entry.name)
        if (match != null) {
          val original = if (rel.isEmpty()) match.groupValues[1] else "$rel/${match.groupValues[1]}"
          if (resolve(tree, original) == null) {
            runCatching { rename(tree, document(tree, entry.id), match.groupValues[1]); restored++ }
          }
        }
      }
    }
    return restored
  }

  private fun probe(treeRaw: String): Map<String, Any> {
    val tree = requireTree(treeRaw)
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val root = queryEntry(tree, document(tree, rootId)) ?: throw IllegalStateException("The selected folder cannot be read.")
    if (!root.directory || root.flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE == 0) {
      throw IllegalStateException("This provider does not allow creating files in the selected folder.")
    }
    val token = UUID.randomUUID().toString()
    val folderName = ".inkfish-provider-check-$token"
    var folderUri: Uri? = null
    try {
      val made = DocumentsContract.createDocument(resolver, document(tree, rootId), DocumentsContract.Document.MIME_TYPE_DIR, folderName)
        ?: throw IllegalStateException("The provider refused test-folder creation.")
      folderUri = document(tree, DocumentsContract.getDocumentId(made))
      val folder = queryEntry(tree, folderUri!!) ?: throw IllegalStateException("The test folder could not be read back.")
      if (folder.name != folderName || !folder.directory || folder.flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE == 0) {
        throw IllegalStateException("The provider did not preserve the requested folder name or does not allow nested files.")
      }
      val nestedDirName = "nested-$token"
      val nestedDirRaw = DocumentsContract.createDocument(resolver, folderUri!!, DocumentsContract.Document.MIME_TYPE_DIR, nestedDirName)
        ?: throw IllegalStateException("The provider refused nested-folder creation.")
      val nestedDir = document(tree, DocumentsContract.getDocumentId(nestedDirRaw))
      val testName = "capability-$token.md"
      val fileUri = createFile(tree, nestedDir, testName)
      val expected = "Inkfish SAF capability check $token".toByteArray(Charsets.UTF_8)
      writeBytes(tree, fileUri, expected)
      if (!readBytes(tree, "${folderName}/${nestedDirName}/${testName}").contentEquals(expected)) {
        throw IllegalStateException("The provider failed read-after-write verification.")
      }
      val renamed = rename(tree, fileUri, "renamed-$token.md")
      if (queryEntry(tree, renamed)?.name != "renamed-$token.md") throw IllegalStateException("The provider cannot safely rename files.")
      val renamedDir = rename(tree, nestedDir, "renamed-dir-$token")
      if (children(tree, DocumentsContract.getDocumentId(renamedDir)).none { it.name == "renamed-$token.md" }) {
        throw IllegalStateException("The provider cannot list nested folders reliably.")
      }
      val occupiedName = "occupied-$token.md"
      val occupied = createFile(tree, renamedDir, occupiedName)
      val keepBytes = "keep-existing-$token".toByteArray(Charsets.UTF_8)
      writeBytes(tree, occupied, keepBytes)
      val contender = createFile(tree, renamedDir, "contender-$token.md")
      writeBytes(tree, contender, "new-copy-$token".toByteArray(Charsets.UTF_8))
      runCatching { DocumentsContract.renameDocument(resolver, contender, occupiedName) }
      val occupiedEntries = children(tree, DocumentsContract.getDocumentId(renamedDir)).filter { it.name == occupiedName }
      if (occupiedEntries.size != 1 || digestUri(document(tree, occupiedEntries.single().id)) != sha(keepBytes)) {
        throw IllegalStateException("The provider may overwrite or ambiguously duplicate an existing document during rename.")
      }
      deleteRecursively(tree, queryEntry(tree, folderUri!!) ?: folder)
      folderUri = null
      return mapOf("name" to root.name, "files" to true, "nestedDirectories" to true, "rename" to true, "delete" to true, "noOverwrite" to true)
    } catch (e: Exception) {
      folderUri?.let { runCatching { deleteRecursively(tree, queryEntry(tree, it) ?: return@let) } }
      val reason = if (e is SecurityException) "Shared-folder access was revoked while checking the provider." else (e.message ?: "The selected provider lacks required operations.")
      throw IllegalStateException(reason, e)
    }
  }
}
