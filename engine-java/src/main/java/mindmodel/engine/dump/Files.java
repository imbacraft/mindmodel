package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtType;

/**
 * files.ndjson: one row per input file, with its package, whether Spoon could read it, and the errors it reported.
 * A file that produced no type at all is an error too — silence is the one thing the dump may not do.
 *
 * Imports are deliberately absent: only catalog selection needs them, Node already reads them for that, and Spoon's
 * compilation unit does not populate them in no-classpath mode reliably enough to be a contract.
 */
public final class Files {

    private Files() {
    }

    /** @return how many input files carry at least one error. */
    public static int write(List<String> inputs, List<CtType<?>> types, Map<String, List<String>> problems,
            Path root, Path out) throws IOException {
        Map<String, String> pkgOf = new LinkedHashMap<>();
        for (CtType<?> t : types) {
            Positions.Pos p = Positions.of(t, root);
            if (p != null) pkgOf.putIfAbsent(p.file(), t.getPackage() == null ? "" : t.getPackage().getQualifiedName());
        }
        List<String> rows = new ArrayList<>(new TreeSet<>(inputs));
        int failed = 0;
        try (Ndjson w = new Ndjson(out)) {
            for (String path : rows) {
                String pkg = pkgOf.get(path);
                List<String> errors = new ArrayList<>(problems.getOrDefault(path, List.of()));
                if (pkg == null && !path.endsWith("package-info.java") && !path.endsWith("module-info.java"))
                    errors.add("no-types-parsed");
                if (!errors.isEmpty()) failed++;
                w.row(g -> row(g, path, pkg, errors));
            }
        }
        return failed;
    }

    private static void row(JsonGenerator g, String path, String pkg, List<String> errors) throws IOException {
        g.writeStringField("path", path);
        if (pkg == null) g.writeNullField("package");
        else g.writeStringField("package", pkg);
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
