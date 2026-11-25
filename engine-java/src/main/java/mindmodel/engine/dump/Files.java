package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtImport;
import spoon.reflect.declaration.CtImportKind;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * files.ndjson: one row per input file, with its own package, its imports, whether Spoon could read it, and the errors it
 * reported. The package comes from the file's compilation unit, never from a type: a file that declares nothing still
 * declares where it lives. A file that produced no type at all is an error too — silence is the one thing the dump may
 * not do — and the only such error left is a file Spoon read no unit for.
 *
 * Imports are the file's own header, read by Spoon's compilation unit when that fills them, and by a lexical header
 * reader when it does not (a no-classpath unit can leave the list empty). {@code importsOrigin} says which answered;
 * a file whose header could not be read says {@code unresolved} and names the reason.
 */
public final class Files {

    private Files() {
    }

    /** One import as written: the name, whether it ends in `*`, and whether it is static. */
    private record Import(String name, boolean wildcard, boolean isStatic) implements Comparable<Import> {
        @Override
        public int compareTo(Import other) {
            int byName = name.compareTo(other.name);
            if (byName != 0) return byName;
            if (wildcard != other.wildcard) return wildcard ? 1 : -1;
            return isStatic == other.isStatic ? 0 : isStatic ? 1 : -1;
        }
    }

    /** @return how many input files carry at least one error. */
    public static int write(List<String> inputs, List<CtType<?>> types, Map<String, String> packages,
            Map<String, List<String>> problems, Positions positions, Path out, Failures failures) throws IOException {
        // A file's package is the one its own header declares, read from its compilation unit. Taking it from a type
        // borrowed the type's file instead: a file that declares no type (all of it commented out) has a package and no
        // type, and a file whose type Spoon built as a bare shell has neither — the row has to say which file it is.
        Map<String, String> pkgOf = new LinkedHashMap<>();
        Map<String, List<Import>> written = new LinkedHashMap<>();
        for (CtType<?> t : types) {
            Positions.Pos p = positions.of(t);
            if (p == null) continue;
            pkgOf.putIfAbsent(p.file(), t.getPackage() == null ? "" : t.getPackage().getQualifiedName());
            if (!written.containsKey(p.file())) written.put(p.file(), fromUnit(t, failures));
        }
        List<String> rows = new ArrayList<>(new TreeSet<>(inputs));
        Map<String, Imports> imports = importsOf(rows, written, positions.root());
        int failed = 0;
        try (Ndjson w = new Ndjson(out)) {
            for (String path : rows) {
                String pkg = packages.getOrDefault(path, pkgOf.get(path));
                List<String> errors = new ArrayList<>(problems.getOrDefault(path, List.of()));
                // A file Spoon read no compilation unit for is the one genuine parse failure left: nothing about it was
                // read. A file whose unit exists was parsed, whether it declares a type or nothing but comments.
                if (!packages.containsKey(path)) errors.add("not-read");
                if (!errors.isEmpty()) failed++;
                Imports own = imports.get(path);
                w.row(g -> row(g, path, pkg, errors, own.list(), own.origin()));
            }
        }
        return failed;
    }

    /** A file's imports and where they were read from: `spoon` or `header`, or `unresolved` when neither could say. */
    private record Imports(List<Import> list, String origin) {
    }

    /**
     * The header is what the file says; Spoon's list is what the parse kept. Agreement is the common case, and a header
     * the reader cannot take falls back to Spoon's list.
     */
    private static Map<String, Imports> importsOf(List<String> rows, Map<String, List<Import>> written, Path root) {
        Map<String, Imports> out = new LinkedHashMap<>();
        for (String path : rows) {
            List<Import> header = header(root, path);
            List<Import> unit = written.get(path);
            if (header != null) {
                out.put(path, new Imports(header, unit != null && unit.equals(header) ? "spoon" : "header"));
            }
            else if (unit != null) out.put(path, new Imports(unit, "spoon"));
            else out.put(path, new Imports(List.of(), "unresolved"));
        }
        return out;
    }

    /** Spoon's own import list for the file a type was read from, or null when there is no compilation unit. */
    private static List<Import> fromUnit(CtType<?> type, Failures failures) {
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
            failures.count("files.importsUnreadable");
            return null;
        }
    }

    private static Import of(CtImport item) {
        CtImportKind kind = item.getImportKind();
        boolean wildcard = kind == CtImportKind.ALL_TYPES || kind == CtImportKind.ALL_STATIC_MEMBERS;
        boolean isStatic = kind == CtImportKind.ALL_STATIC_MEMBERS || kind == CtImportKind.FIELD
                || kind == CtImportKind.METHOD;
        return new Import(nameOf(item.getReference()), wildcard, isStatic);
    }

    /** A type as its qualified name, a static member as `owner.member` — the same text the header reader produces. */
    private static String nameOf(CtReference reference) {
        if (reference == null) return "";
        if (reference instanceof CtTypeReference<?> type) return Names.qualified(type);
        if (reference instanceof spoon.reflect.reference.CtFieldReference<?> field)
            return field.getDeclaringType() == null ? field.getSimpleName()
                    : Names.dotted(Names.qualified(field.getDeclaringType()), field.getSimpleName());
        if (reference instanceof spoon.reflect.reference.CtExecutableReference<?> executable)
            return executable.getDeclaringType() == null ? executable.getSimpleName()
                    : Names.dotted(Names.qualified(executable.getDeclaringType()), executable.getSimpleName());
        return reference.getSimpleName();
    }

    /**
     * The header lines only: `package`, then `import` until the first declaration. Read without regular expressions and
     * never past the header, so nothing here can turn into a second reader of Java bodies.
     */
    private static List<Import> header(Path root, String path) {
        try (var reader = java.nio.file.Files.newBufferedReader(
                root.resolve(path), java.nio.charset.StandardCharsets.UTF_8)) {
            List<Import> out = new ArrayList<>();
            String line;
            while ((line = reader.readLine()) != null) {
                String text = line.trim();
                if (text.isEmpty() || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) continue;
                if (text.startsWith("package ") || text.startsWith("package\t")) continue;
                if (!text.startsWith("import ")) break; // the first declaration ends the header
                String rest = text.substring("import ".length()).trim();
                boolean isStatic = false;
                if (rest.startsWith("static ")) {
                    isStatic = true;
                    rest = rest.substring("static ".length()).trim();
                }
                int end = rest.indexOf(';');
                if (end < 0) break; // a malformed header is not a guess
                rest = rest.substring(0, end).trim();
                boolean wildcard = rest.endsWith(".*");
                if (wildcard) rest = rest.substring(0, rest.length() - 2);
                if (!rest.isEmpty()) out.add(new Import(rest, wildcard, isStatic));
            }
            out.sort(null);
            return out;
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * The types a file's header statically imports a member of: `import static a.b.C.NAME;` names `a.b.C`, and
     * `import static a.b.C.Nested;` could be either, so both spellings are returned. Read by the same header reader that
     * answers the imports row — a static import Spoon cannot resolve never reaches its own list.
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

    private static void row(JsonGenerator g, String path, String pkg, List<String> errors, List<Import> imports,
            String origin) throws IOException {
        g.writeStringField("path", path);
        if (pkg == null) g.writeNullField("package");
        else g.writeStringField("package", pkg);
        g.writeArrayFieldStart("imports");
        for (Import item : imports) {
            g.writeStartObject();
            g.writeStringField("name", item.name());
            g.writeBooleanField("wildcard", item.wildcard());
            g.writeBooleanField("static", item.isStatic());
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeStringField("importsOrigin", origin);
        if ("unresolved".equals(origin)) g.writeStringField("importsReason", "header-unreadable");
        g.writeBooleanField("test", path.matches(".*(^|/)(test|integration-test|it)/.*"));
        g.writeArrayFieldStart("errors");
        for (String error : errors) {
            g.writeStartObject();
            g.writeStringField("reason", error);
            g.writeEndObject();
        }
        g.writeEndArray();
    }
}
