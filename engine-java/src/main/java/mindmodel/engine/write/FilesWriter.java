package mindmodel.engine.write;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.FileProblems;
import mindmodel.engine.model.Imports;
import mindmodel.engine.model.Positions;

/**
 * files.ndjson: one row per input file, with its own package, its imports and where they were read from, and the
 * problems it carries. The package comes from the file's compilation unit, never from a type: a file that declares
 * nothing still declares where it lives. Silence is the one thing the dump may not do, so a file no unit was read for
 * is named as `not-read`.
 */
public final class FilesWriter {

    private FilesWriter() {
    }

    /** Writes the section and returns how many input files carry at least one problem. */
    public static int write(List<String> inputs, List<CtType<?>> types, Map<String, String> packages,
            Map<String, List<FileProblems.Problem>> problems, Positions positions, Path out, Failures failures)
            throws IOException {
        // A file's package is the one its own header declares, read from its compilation unit. A file whose type Spoon
        // built as a bare shell has no usable type, so its package is taken from the file, not the type.
        Map<String, String> pkgOf = new LinkedHashMap<>();
        Map<String, List<Imports.Import>> fromUnits = new LinkedHashMap<>();
        for (CtType<?> t : types) {
            Positions.Pos p = positions.of(t);
            if (p == null) continue;
            pkgOf.putIfAbsent(p.file(), t.getPackage() == null ? "" : t.getPackage().getQualifiedName());
            if (!fromUnits.containsKey(p.file())) fromUnits.put(p.file(), Imports.fromUnit(t, failures));
        }
        List<String> rows = new ArrayList<>(new TreeSet<>(inputs));
        Map<String, Imports.Read> imports = Imports.resolve(positions.root(), rows, fromUnits);
        int failed = 0;
        try (Ndjson w = new Ndjson(out)) {
            for (String path : rows) {
                // The default package is no package: an empty name is never written.
                String found = packages.getOrDefault(path, pkgOf.get(path));
                String pkg = found == null || found.isEmpty() ? null : found;
                List<FileProblems.Problem> errors = new ArrayList<>(problems.getOrDefault(path, List.of()));
                // A file Spoon read no compilation unit for is the one genuine parse failure left: nothing about it was
                // read. A file whose unit exists was parsed, whether it declares a type or nothing but comments.
                if (!packages.containsKey(path)) errors.add(new FileProblems.Problem("not-read", "not-read", null));
                if (!errors.isEmpty()) failed++;
                Imports.Read own = imports.get(path);
                w.row(g -> row(g, path, pkg, errors, own));
            }
        }
        return failed;
    }

    private static void row(JsonGenerator g, String path, String pkg, List<FileProblems.Problem> errors,
            Imports.Read imports) throws IOException {
        g.writeStringField("path", path);
        Json.key(g, "package", pkg);
        g.writeArrayFieldStart("imports");
        for (Imports.Import item : imports.list()) {
            g.writeStartObject();
            g.writeStringField("name", item.name());
            g.writeBooleanField("wildcard", item.wildcard());
            g.writeBooleanField("static", item.isStatic());
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeStringField("importsOrigin", imports.origin());
        if ("unresolved".equals(imports.origin())) g.writeStringField("importsReason", "header-unreadable");
        g.writeBooleanField("test", path.matches(".*(^|/)(test|integration-test|it)/.*"));
        g.writeArrayFieldStart("errors");
        for (FileProblems.Problem error : errors) {
            g.writeStartObject();
            g.writeStringField("kind", error.kind());
            g.writeStringField("reason", error.reason());
            if (error.line() == null) g.writeNullField("line");
            else g.writeNumberField("line", error.line());
            g.writeEndObject();
        }
        g.writeEndArray();
    }
}
