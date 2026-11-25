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
 * {@code dump <root> <file-list> <out-dir>}: one typed model of the checkout as streamed sections. Contract 6.
 * Deterministic by construction: rows are ordered by file, then source position, then name.
 */
public final class Dump {

    public static final int CONTRACT = 6;
    public static final String ENGINE = "spoon-11.5.0";

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

    public static void run(Path root, Path listPath, Path outDir, int compliance, List<String> classpath,
            List<String> generatedDirs) throws IOException {
        java.nio.file.Files.createDirectories(outDir);
        List<String> inputs = SourceModel.relativeFiles(root,
                java.nio.file.Files.readAllLines(listPath, StandardCharsets.UTF_8));
        SourceModel model;
        String dropped = null;
        try {
            model = SourceModel.build(root, inputs, compliance, classpath, generatedDirs);
        } catch (Exception | LinkageError failure) {
            // A classpath is an improvement, never a condition: a jar the reader cannot take (a class file from a newer
            // Java, a corrupt entry) is dropped and the dump is rebuilt without it, exactly as it ran before.
            if (classpath.isEmpty()) throw failure;
            dropped = failure.getClass().getSimpleName()
                    + (failure.getMessage() == null ? "" : ": " + failure.getMessage());
            if (dropped.length() > 200) dropped = dropped.substring(0, 200);
            model = SourceModel.build(root, inputs, compliance, List.of(), generatedDirs);
        }
        List<Row> rows = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (CtType<?> t : model.allTypes()) collect(model, t, rows, seen, root);
        // A file whose type came out as a bare shell is read again in its own model: the shell is a name and nothing
        // else, so the declaration has to be read where no static import has laid the shell first.
        List<String> unread = recover(root, model, inputs, compliance, rows, seen);
        rows.sort(ORDER);
        List<CtType<?>> types = new ArrayList<>();
        for (Row r : rows) types.add(r.type());
        // The generated sources are in the model for resolution only: a reader of call targets must know their
        // members, but not one row is written for them.
        List<CtType<?>> known = new ArrayList<>(types);
        for (CtType<?> t : model.allTypes()) if (model.isGenerated(t) && declared(t)) known.add(t);
        java.util.Map<String, List<Lombok.Item>> synth = Lombok.synthesize(types, root);
        Types.write(types, root, outDir.resolve("types.ndjson"));
        // One walk per body: the call rows carry the ids the other sections name, so calls are written first.
        CallIds ids = new CallIds();
        Failures failures = new Failures();
        Refs refs = new Refs(ids, failures);
        Sites.Written written = Sites.write(types, known, synth, root, outDir.resolve("calls.ndjson"), ids, refs);
        Members.write(types, synth, root, outDir.resolve("members.ndjson"), written.returns());
        FieldAccesses.write(written.fields(), outDir.resolve("fields.ndjson"));
        // The library types the classpath let Spoon read: shallow rows, no positions, never cited (LibraryStubs).
        int libraries = mindmodel.engine.dump.LibraryStubs.write(types, known, outDir.resolve("library.ndjson"));
        int failed = Files.write(inputs, types, model.packages(), problems(model, root, unread), root,
                outDir.resolve("files.ndjson"), failures);
        meta(root, inputs, types, failed, compliance, outDir.resolve("meta.json"), classpath, generatedDirs,
                model.generatedFiles(), libraries, dropped, failures);
    }

    /**
     * Reads again the files whose declared types Spoon built as bare shells, and adds what they declare to `rows`.
     * The second model holds every input except the files whose static imports name one of those types — the imports
     * that laid the shells — so each type is read from its own source, with the rest of the project still in reach.
     *
     * @return the files still unread after that, to be reported rather than filled in.
     */
    private static List<String> recover(Path root, SourceModel model, List<String> inputs, int compliance,
            List<Row> rows, java.util.Set<String> seen) throws IOException {
        List<String> ghosts = model.unreadFiles();
        if (ghosts.isEmpty()) return List.of();
        // The shells carry no position but they do carry their names, which is what the imports were written with.
        java.util.Set<String> skip = new java.util.HashSet<>(model.filesImporting(model.unreadNames()));
        List<String> rest = new ArrayList<>(inputs);
        rest.removeAll(skip);
        SourceModel own = SourceModel.build(root, rest, compliance, List.of(), model.generatedDirs());
        for (CtType<?> t : own.allTypes()) collect(own, t, rows, seen, root);
        return own.unreadFiles();
    }

    /**
     * A type and its nested types; anonymous and local classes are not types of their own (D2 keeps their calls). A
     * generated type is never one of them: it is in the model for resolution, and the dump writes nothing for it.
     */
    private static void collect(SourceModel model, CtType<?> t, List<Row> rows, java.util.Set<String> seen, Path root) {
        // A type Spoon resolved but never read has no position: it is a library or a shadow, not a declaration here.
        if (t.getPosition() == null || !t.getPosition().isValidPosition()) return;
        if (!declared(t) || model.isGenerated(t)) return;
        if (seen.add(Names.qualified(t))) rows.add(new Row(t, Positions.of(t, root)));
        for (CtType<?> nested : t.getNestedTypes()) collect(model, nested, rows, seen, root);
    }

    /** A type the map may name: not anonymous, not a class declared inside a method body. */
    private static boolean declared(CtType<?> t) {
        if (t.isAnonymous()) return false;
        return !(t.getDeclaringType() == null && t.getParent(CtExecutable.class) != null);
    }

    /** Parse errors by project-relative file, so the dump names what it could not read. */
    private static java.util.Map<String, List<String>> problems(SourceModel model, Path root, List<String> unread) {
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
            if (!file.startsWith(base) || model.isGeneratedFile(file)) continue;
            String rel = base.relativize(file).toString().replace('\\', '/');
            out.computeIfAbsent(rel, k -> new ArrayList<>()).add(problem.getMessage());
        }
        // A file whose type is still a bare shell after the second read: the row says so rather than claiming a type.
        for (String rel : unread) out.computeIfAbsent(rel, k -> new ArrayList<>()).add("type-without-position");
        return out;
    }

    private static void meta(Path root, List<String> inputs, List<CtType<?>> types, int failed, int compliance,
            Path out, List<String> classpath, List<String> generatedDirs, int generatedFiles, int libraries,
            String dropped, Failures failures) throws IOException {
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
            // No timestamp: a dump of the same inputs is byte-identical, directory and all.
            g.writeObjectFieldStart("classpath");
            g.writeNumberField("entries", classpath.size());
            g.writeStringField("sha256", jarDigest(classpath));
            g.writeNumberField("generatedDirs", generatedDirs.size());
            // Generated files in the model: read so a project call into one resolves, written as nothing.
            g.writeNumberField("generatedFiles", generatedFiles);
            g.writeNumberField("libraryTypes", libraries);
            if (dropped != null) g.writeStringField("dropped", dropped);
            g.writeEndObject();
            g.writeObjectFieldStart("counts");
            g.writeNumberField("files", inputs.size());
            g.writeNumberField("types", types.size());
            g.writeNumberField("fields", fields);
            g.writeNumberField("methods", methods);
            g.writeNumberField("failedFiles", failed);
            // What the engine answered empty rather than failing, by reason: a run says what it could not read.
            for (var count : failures.counts().entrySet()) g.writeNumberField(count.getKey(), count.getValue());
            g.writeEndObject();
            g.writeEndObject();
        }
    }

    /**
     * A digest of the classpath as given: each entry's path and size, in order, so a run says which jars it read and a
     * changed jar set changes the digest. Paths only — the jars themselves are never read twice.
     */
    private static String jarDigest(List<String> classpath) throws IOException {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            for (String entry : classpath) {
                java.nio.file.Path p = java.nio.file.Path.of(entry);
                long size = java.nio.file.Files.isRegularFile(p) ? java.nio.file.Files.size(p) : 0;
                md.update((entry + ":" + size + "\n").getBytes(StandardCharsets.UTF_8));
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            return "";
        }
    }
}
