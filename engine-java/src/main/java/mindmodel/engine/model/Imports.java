package mindmodel.engine.model;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import spoon.reflect.declaration.CtImport;
import spoon.reflect.declaration.CtImportKind;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * A file's imports, read two ways: from its own header text, and from the compilation unit Spoon built. The header is
 * what the file says; Spoon's list is what the parse kept. Agreement is the common case, and a header the reader cannot
 * take falls back to Spoon's list.
 */
public final class Imports {

    /** One import as written: the name, whether it ends in `*`, and whether it is static. */
    public record Import(String name, boolean wildcard, boolean isStatic) implements Comparable<Import> {
        @Override
        public int compareTo(Import other) {
            int byName = name.compareTo(other.name);
            if (byName != 0) return byName;
            if (wildcard != other.wildcard) return wildcard ? 1 : -1;
            return isStatic == other.isStatic ? 0 : isStatic ? 1 : -1;
        }
    }

    /** A file's imports and where they were read from: `spoon` or `header`, or `unresolved` when neither could say. */
    public record Read(List<Import> list, String origin) {
    }

    private Imports() {
    }

    /** Spoon's own import list for the file a type was read from, or null when there is no compilation unit. */
    public static List<Import> fromUnit(CtType<?> type, Failures failures) {
        try {
            var position = type.getPosition();
            if (position == null || !position.isValidPosition() || position.getCompilationUnit() == null) return null;
            List<CtImport> imports = position.getCompilationUnit().getImports();
            if (imports == null) return null;
            List<Import> out = new ArrayList<>();
            for (CtImport item : imports) out.add(of(item));
            out.sort(null);
            return out;
        } catch (RuntimeException e) {
            failures.count(Failures.Key.IMPORTS_UNREADABLE);
            return null;
        }
    }

    /**
     * Each file's imports: the header when it reads, unless the header is empty where Spoon found some (the reader's
     * miss, not the file's); else Spoon's list; else unresolved.
     */
    public static Map<String, Read> resolve(Path root, List<String> paths, Map<String, List<Import>> fromUnits) {
        Map<String, Read> out = new LinkedHashMap<>();
        for (String path : paths) {
            List<Import> header = header(root, path);
            List<Import> unit = fromUnits.get(path);
            boolean headerMissed = header != null && header.isEmpty() && unit != null && !unit.isEmpty();
            if (header != null && !headerMissed) {
                out.put(path, new Read(header, unit != null && unit.equals(header) ? "spoon" : "header"));
            } else if (unit != null) {
                out.put(path, new Read(unit, "spoon"));
            } else {
                out.put(path, new Read(List.of(), "unresolved"));
            }
        }
        return out;
    }

    /**
     * The static imports a file's header writes, in header order. Spoon's own list cannot be used for them: an import
     * of a type that is not on the classpath is unresolved there, with no name. None when the header cannot be read.
     */
    public static List<Import> staticImports(Path root, String path) {
        List<Import> out = new ArrayList<>();
        List<Import> lines = header(root, path);
        if (lines != null) for (Import item : lines) if (item.isStatic()) out.add(item);
        return out;
    }

    /**
     * The types a file's header statically imports a member of: `import static a.b.C.NAME;` names `a.b.C`, and `import
     * static a.b.C.Nested;` could be either, so both spellings are returned. Read by the same header reader that
     * answers the imports row, so a static import Spoon cannot resolve is still here.
     */
    public static Set<String> staticOwners(Path root, String path) {
        Set<String> out = new TreeSet<>();
        List<Import> lines = header(root, path);
        if (lines == null) return out;
        for (Import item : lines) {
            if (!item.isStatic()) continue;
            out.add(item.name());
            int last = item.name().lastIndexOf('.');
            if (!item.wildcard() && last > 0) out.add(item.name().substring(0, last));
        }
        return out;
    }

    private static Import of(CtImport item) {
        CtImportKind kind = item.getImportKind();
        boolean wildcard = kind == CtImportKind.ALL_TYPES || kind == CtImportKind.ALL_STATIC_MEMBERS;
        boolean isStatic = kind == CtImportKind.ALL_STATIC_MEMBERS || kind == CtImportKind.FIELD
                || kind == CtImportKind.METHOD;
        return new Import(nameOf(item.getReference()), wildcard, isStatic);
    }

    /** A type as its qualified name, a static member as `owner.member`: the same text the header reader produces. */
    private static String nameOf(CtReference reference) {
        if (reference == null) return "";
        if (reference instanceof CtTypeReference<?> type) return Names.qualified(type);
        if (reference instanceof CtFieldReference<?> field)
            return field.getDeclaringType() == null ? field.getSimpleName()
                    : Names.dotted(Names.qualified(field.getDeclaringType()), field.getSimpleName());
        if (reference instanceof CtExecutableReference<?> executable)
            return executable.getDeclaringType() == null ? executable.getSimpleName()
                    : Names.dotted(Names.qualified(executable.getDeclaringType()), executable.getSimpleName());
        return reference.getSimpleName();
    }

    /**
     * The header lines only: `package`, then `import` until the first declaration. Read without regular expressions and
     * never past the header, so nothing here can turn into a second reader of Java bodies. A byte-order mark and every
     * block comment (a banner, a license) are skipped whole, so prose inside one is never read as an import. Null when
     * the file cannot be read.
     */
    static List<Import> header(Path root, String path) {
        try (var reader = Files.newBufferedReader(root.resolve(path), StandardCharsets.UTF_8)) {
            List<Import> out = new ArrayList<>();
            String line;
            boolean inBlockComment = false;
            while ((line = reader.readLine()) != null) {
                String text = line.replace("﻿", "").trim();
                if (inBlockComment) {
                    inBlockComment = !text.contains("*/");
                    continue;
                }
                if (text.startsWith("/*")) {
                    inBlockComment = !text.contains("*/");
                    continue;
                }
                if (text.isEmpty() || text.startsWith("//")) continue;
                if (text.startsWith("package ") || text.startsWith("package\t")) continue;
                if (!text.startsWith("import ")) break; // the first declaration ends the header
                Import item = importLine(text);
                if (item == null) break; // a malformed header is not a guess
                if (!item.name().isEmpty()) out.add(item);
            }
            out.sort(null);
            return out;
        } catch (IOException e) {
            return null;
        }
    }

    /** One `import` line as an import (its name may be empty), or null when it has no terminating `;`. */
    private static Import importLine(String text) {
        String rest = text.substring("import ".length()).trim();
        boolean isStatic = false;
        if (rest.startsWith("static ")) {
            isStatic = true;
            rest = rest.substring("static ".length()).trim();
        }
        int end = rest.indexOf(';');
        if (end < 0) return null;
        rest = rest.substring(0, end).trim();
        boolean wildcard = rest.endsWith(".*");
        if (wildcard) rest = rest.substring(0, rest.length() - 2);
        return new Import(rest, wildcard, isStatic);
    }
}
