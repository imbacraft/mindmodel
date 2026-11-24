package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.SourceModel;

/**
 * {@code dump <root> <file-list> <out-dir>}: one typed model of the checkout as streamed sections. Contract 2.
 * Deterministic by construction: rows are ordered by file, then source position, then name.
 */
public final class Dump {

    public static final int CONTRACT = 2;
    public static final String ENGINE = "spoon-11.2.1";

    private Dump() {
    }

    /** A type together with the position it is ordered by, so the sort reads each position once. */
    private record Row(CtType<?> type, Positions.Pos pos) {
    }

    private static final Comparator<Row> ORDER = Comparator
            .comparing((Row r) -> r.pos == null ? "" : r.pos.file())
            .thenComparingInt(r -> r.pos == null ? 0 : r.pos.line())
            .thenComparingInt(r -> r.pos == null ? 0 : r.pos.col())
            .thenComparing(r -> Names.qualified(r.type));

    public static void run(Path root, Path listPath, Path outDir, int compliance) throws IOException {
        java.nio.file.Files.createDirectories(outDir);
        List<String> inputs = SourceModel.relativeFiles(root,
                java.nio.file.Files.readAllLines(listPath, StandardCharsets.UTF_8));
        SourceModel model = SourceModel.build(root, inputs, compliance);
        List<Row> rows = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (CtType<?> t : model.allTypes()) collect(t, rows, seen, root);
        rows.sort(ORDER);
        List<CtType<?>> types = new ArrayList<>();
        for (Row r : rows) types.add(r.type());
        java.util.Map<String, List<Lombok.Item>> synth = Lombok.synthesize(types, root);
        Types.write(types, root, outDir.resolve("types.ndjson"));
        // One walk per body: the call rows carry the ids the other sections name, so calls are written first.
        CallIds ids = new CallIds();
        Refs refs = new Refs(ids);
        Sites.Written written = Sites.write(types, synth, root, outDir.resolve("calls.ndjson"), ids, refs);
        Members.write(types, synth, root, outDir.resolve("members.ndjson"), written.returns());
        FieldAccesses.write(written.fields(), outDir.resolve("fields.ndjson"));
        int failed = Files.write(inputs, types, problems(model, root), root, outDir.resolve("files.ndjson"));
        meta(root, inputs, types, failed, compliance, outDir.resolve("meta.json"));
    }

    /** A type and its nested types; anonymous and local classes are not types of their own (D2 keeps their calls). */
    private static void collect(CtType<?> t, List<Row> rows, java.util.Set<String> seen, Path root) {
        // A type Spoon resolved but never read has no position: it is a library or a shadow, not a declaration here.
        if (t.getPosition() == null || !t.getPosition().isValidPosition()) return;
        if (t.isAnonymous()) return;
        if (t.getDeclaringType() == null && t.getParent(CtExecutable.class) != null) return;
        if (seen.add(Names.qualified(t))) rows.add(new Row(t, Positions.of(t, root)));
        for (CtType<?> nested : t.getNestedTypes()) collect(nested, rows, seen, root);
    }

    /** Parse errors by project-relative file, so the dump names what it could not read. */
    private static java.util.Map<String, List<String>> problems(SourceModel model, Path root) {
        java.util.Map<String, List<String>> out = new java.util.LinkedHashMap<>();
        Path base = root.toAbsolutePath().normalize();
        for (var problem : model.problems()) {
            char[] name = problem.getOriginatingFileName();
            if (name == null) continue;
            // Without a classpath JDT reports every missing framework type, every Lombok accessor and every feature
            // above the compliance level. None of that means the file is unreadable: only a syntax error does.
            String message = problem.getMessage();
            if (!message.startsWith("Syntax error")) continue;
            Path file = Path.of(new String(name)).toAbsolutePath().normalize();
            if (!file.startsWith(base)) continue;
            String rel = base.relativize(file).toString().replace('\\', '/');
            out.computeIfAbsent(rel, k -> new ArrayList<>()).add(problem.getMessage());
        }
        return out;
    }

    private static void meta(Path root, List<String> inputs, List<CtType<?>> types, int failed, int compliance,
            Path out) throws IOException {
        int fields = 0;
        int methods = 0;
        for (CtType<?> t : types) {
            fields += t.getFields().size();
            methods += t.getMethods().size();
        }
        try (JsonGenerator g = new JsonFactory().createGenerator(out.toFile(), JsonEncoding.UTF8)) {
            g.useDefaultPrettyPrinter();
            g.writeStartObject();
            g.writeNumberField("contract", CONTRACT);
            g.writeStringField("engine", ENGINE);
            g.writeNumberField("compliance", compliance);
            g.writeStringField("root", root.getFileName() == null ? "" : root.getFileName().toString());
            g.writeStringField("generatedAt", java.time.Instant.now().toString());
            g.writeObjectFieldStart("counts");
            g.writeNumberField("files", inputs.size());
            g.writeNumberField("types", types.size());
            g.writeNumberField("fields", fields);
            g.writeNumberField("methods", methods);
            g.writeNumberField("failedFiles", failed);
            g.writeEndObject();
            g.writeEndObject();
        }
    }
}
