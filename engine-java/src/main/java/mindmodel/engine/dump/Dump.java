package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.SourceModel;

/**
 * {@code dump <root> <file-list> <out-dir>}: one typed model of the checkout as streamed sections. Contract 7.
 * Deterministic by construction: rows are ordered by file, then source position, then name.
 */
public final class Dump {

    public static final int CONTRACT = 7;
    public static final String ENGINE = "spoon-11.5.0";

    private Dump() {
    }

    /** A type together with the position it is ordered by, so the sort reads each position once. */
    private record Row(CtType<?> type, Positions.Pos pos) {
    }

    /** The model the dump reads, and the classpath entry it had to drop to build it (null when it dropped none). */
    private record Read(SourceModel model, String dropped) {
    }

    private static final Comparator<Row> ORDER = Comparator
            .comparing((Row r) -> r.pos() == null ? "" : r.pos().file())
            .thenComparingInt(r -> r.pos() == null ? 0 : r.pos().line())
            .thenComparingInt(r -> r.pos() == null ? 0 : r.pos().col())
            .thenComparing(r -> Names.qualified(r.type()));

    public static void run(Path given, Path listPath, Path outDir, int compliance, List<String> classpath,
            List<String> generatedDirs) throws IOException {
        // Spoon reports canonical paths (macOS /var is /private/var): every relativised or prefix-checked path below
        // is measured against the canonical root, or it comes out as ../../ paths.
        Path root = SourceModel.realPath(given);
        java.nio.file.Files.createDirectories(outDir);
        // Sorted, so the model Spoon builds from them, and the first of two same-named declarations, do not depend on
        // the order the list was written in.
        List<String> inputs = new ArrayList<>(SourceModel.relativeFiles(root,
                java.nio.file.Files.readAllLines(listPath, StandardCharsets.UTF_8)));
        inputs.sort(null);
        Read read = readModel(root, inputs, compliance, classpath, generatedDirs);
        SourceModel model = read.model();
        // The classpath that model actually read with: a dropped one is dropped for every later model too.
        List<String> reads = read.dropped() == null ? classpath : List.of();
        Positions positions = new Positions(root);
        Failures failures = new Failures();
        countDuplicateDeclarations(model, root, compliance, reads, failures);
        Declared declared = declaredTypes(model, inputs, compliance, reads, positions);
        List<CtType<?>> types = declared.types();
        // The generated sources are in the model for resolution only: a reader of call targets must know their
        // members, but not one row is written for them.
        List<CtType<?>> known = new ArrayList<>(types);
        for (CtType<?> t : model.allTypes()) if (model.isGenerated(t) && declared(t)) known.add(t);
        Map<String, List<Lombok.Item>> synth = Lombok.synthesize(types, positions, failures);
        Types.write(types, positions, outDir.resolve("types.ndjson"));
        // Every body is walked once; the call rows carry the ids the other sections name, so calls are written first.
        Walk.Bodies bodies = new Walk.Bodies(types, positions);
        CallIds ids = new CallIds();
        Refs refs = new Refs(ids, failures);
        Sites.Written written = Sites.write(types, known, Lombok.Index.of(synth), bodies, positions,
                outDir.resolve("calls.ndjson"), ids, refs);
        Members.write(types, synth, bodies, positions, outDir.resolve("members.ndjson"), written.returns(), failures);
        FieldAccesses.write(written.fields(), outDir.resolve("fields.ndjson"));
        // The library types the classpath let Spoon read: shallow rows, no positions, never cited (LibraryStubs).
        int libraries = LibraryStubs.write(types, known, outDir.resolve("library.ndjson"));
        int failed = Files.write(inputs, types, model.packages(), problems(model, positions, declared.unread()),
                positions, outDir.resolve("files.ndjson"), failures);
        meta(root, inputs, types, failed, compliance, outDir.resolve("meta.json"), classpath, generatedDirs,
                model.generatedFiles(), libraries, read.dropped(), failures);
    }

    /** The declared types in dump order, and the files whose types stayed bare shells after the second read. */
    private record Declared(List<CtType<?>> types, List<String> unread) {
    }

    private static Declared declaredTypes(SourceModel model, List<String> inputs, int compliance,
            List<String> classpath, Positions positions) throws IOException {
        List<Row> rows = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (CtType<?> t : model.allTypes()) collect(model, t, rows, seen, positions);
        // A file whose type came out as a bare shell is read again in its own model: the shell is a name and nothing
        // else, so the declaration has to be read where no static import has laid the shell first.
        List<String> unread = recover(model, inputs, compliance, classpath, rows, seen, positions);
        rows.sort(ORDER);
        List<CtType<?>> types = new ArrayList<>();
        for (Row r : rows) types.add(r.type());
        return new Declared(types, unread);
    }

    /**
     * The model over the inputs, with the classpath when it reads. A classpath is an improvement, never a condition: a
     * jar the reader cannot take (a class file from a newer Java, a corrupt entry) is dropped, and the model is rebuilt
     * without it, exactly as it ran before. The drop is recorded in meta.json.
     */
    private static Read readModel(Path root, List<String> inputs, int compliance, List<String> classpath,
            List<String> generatedDirs) {
        try {
            return new Read(SourceModel.build(root, inputs, compliance, classpath, generatedDirs), null);
        } catch (Exception | LinkageError failure) {
            if (classpath.isEmpty()) throw failure;
            String dropped = failure.getClass().getSimpleName()
                    + (failure.getMessage() == null ? "" : ": " + failure.getMessage());
            if (dropped.length() > 200) dropped = dropped.substring(0, 200);
            return new Read(SourceModel.build(root, inputs, compliance, List.of(), generatedDirs), dropped);
        }
    }

    /**
     * Reads again the files whose declared types Spoon built as bare shells, and adds what they declare to `rows`.
     * The second model holds every input except the files whose static imports name one of those types — the imports
     * that laid the shells — so each type is read from its own source, with the rest of the project still in reach.
     *
     * @return the files still unread after that, to be reported rather than filled in.
     */
    private static List<String> recover(SourceModel model, List<String> inputs, int compliance, List<String> classpath,
            List<Row> rows, Set<String> seen, Positions positions) throws IOException {
        List<String> ghosts = model.unreadFiles();
        if (ghosts.isEmpty()) return List.of();
        // The shells carry no position but they do carry their names, which is what the imports were written with.
        Set<String> skip = new HashSet<>(model.filesImporting(model.unreadNames()));
        List<String> rest = new ArrayList<>(inputs);
        rest.removeAll(skip);
        SourceModel own = SourceModel.build(positions.root(), rest, compliance, classpath, model.generatedDirs());
        for (CtType<?> t : own.allTypes()) collect(own, t, rows, seen, positions);
        return own.unreadFiles();
    }

    /**
     * A type and its nested types; anonymous and local classes are not types of their own (D2 keeps their calls). A
     * generated type is never one of them: it is in the model for resolution, and the dump writes nothing for it.
     */
    private static void collect(SourceModel model, CtType<?> t, List<Row> rows, Set<String> seen,
            Positions positions) {
        // A type Spoon resolved but never read has no position: it is a library or a shadow, not a declaration here.
        if (t.getPosition() == null || !t.getPosition().isValidPosition()) return;
        if (!declared(t) || model.isGenerated(t)) return;
        if (seen.add(Names.qualified(t))) rows.add(new Row(t, positions.of(t)));
        for (CtType<?> nested : t.getNestedTypes()) collect(model, nested, rows, seen, positions);
    }

    /**
     * A name two input files declare is one row: an id is the name, so there is no second id to give it, and the first
     * file in sorted order keeps it. Spoon drops the other declaration with its unit's type, so the files that declare
     * nothing are read again alone, and each name one of them declares that the model kept is counted as
     * `types.duplicateFqn`. Only a run with such a file pays for the second read.
     */
    private static void countDuplicateDeclarations(SourceModel model, Path root, int compliance,
            List<String> classpath, Failures failures) throws IOException {
        List<String> silent = model.unitsWithoutTypes();
        if (silent.isEmpty()) return;
        Set<String> kept = model.declaredNames();
        SourceModel again = SourceModel.build(root, silent, compliance, classpath, model.generatedDirs());
        for (String name : again.declaredNames()) if (kept.contains(name)) failures.count("types.duplicateFqn");
    }

    private static boolean declared(CtType<?> t) {
        if (t.isAnonymous()) return false;
        return !(t.getDeclaringType() == null && t.getParent(CtExecutable.class) != null);
    }

    /** Parse errors by project-relative file, so the dump names what it could not read. */
    private static Map<String, List<String>> problems(SourceModel model, Positions positions, List<String> unread) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        Path base = positions.root();
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
            out.computeIfAbsent(rel, k -> new ArrayList<>()).add(message);
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
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("the JDK has no SHA-256", e);
        }
        for (String entry : classpath) {
            Path p = Path.of(entry);
            long size = java.nio.file.Files.isRegularFile(p) ? java.nio.file.Files.size(p) : 0;
            md.update((entry + ":" + size + "\n").getBytes(StandardCharsets.UTF_8));
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
