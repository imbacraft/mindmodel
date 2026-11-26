package mindmodel.engine.run;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import spoon.reflect.declaration.CtType;

import mindmodel.engine.model.Classpath;
import mindmodel.engine.model.Declarations;
import mindmodel.engine.model.Duplicates;
import mindmodel.engine.model.Failures;
import mindmodel.engine.model.FileProblems;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.SourceModel;
import mindmodel.engine.model.SourceText;
import mindmodel.engine.model.Walk;
import mindmodel.engine.resolve.CallIds;
import mindmodel.engine.resolve.Lombok;
import mindmodel.engine.resolve.LombokOracle;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.write.CallsWriter;
import mindmodel.engine.write.FieldsWriter;
import mindmodel.engine.write.FilesWriter;
import mindmodel.engine.write.LibraryWriter;
import mindmodel.engine.write.MembersWriter;
import mindmodel.engine.write.MetaWriter;
import mindmodel.engine.write.TypesWriter;

/**
 * The dump pipeline, top to bottom: read the checkout's model, count what Spoon merged, collect the declared types,
 * then write each section from them. The order is the dependency order: calls first, because their rows own the ids and
 * the returns that members and fields are written from.
 */
public final class Dump {

    private Dump() {
    }

    /**
     * Dumps the checkout at {@code given}, over the files listed in {@code listPath}, into {@code outDir}.
     *
     * @param compliance the Java level the sources are read at
     * @param classpath dependency jars or class folders the model reads with, when it can
     * @param generatedDirs annotation-processor output folders, read for resolution and never written
     * @param lombok the Lombok jar delombok runs with, or null: without it the hand-written Lombok rules answer
     */
    public static void run(Path given, Path listPath, Path outDir, int compliance, List<String> classpath,
            List<String> generatedDirs, Path lombok) throws IOException {
        // Spoon reports canonical paths (macOS /var is /private/var): every relativised or prefix-checked path below is
        // measured against the canonical root.
        SourceText.clear();
        Path root = SourceModel.realPath(given);
        Failures.knownPaths(List.of(given, root), classpath);
        Files.createDirectories(outDir);
        Failures failures = new Failures();
        List<String> inputs = inputs(root, listPath, failures);
        List<Classpath.Dropped> unreadable = new ArrayList<>();
        List<String> usable = Classpath.readable(classpath, unreadable, failures);
        countNotUtf8(root, inputs, failures);
        SourceModel.Load load = SourceModel.load(root, inputs, compliance, usable, generatedDirs);
        SourceModel model = load.model();
        // The classpath that model actually read with: a dropped one is dropped for every later model too.
        List<String> reads = load.dropped() == null ? usable : List.of();
        Positions positions = new Positions(root);
        Duplicates.count(model, root, compliance, reads, failures);
        Declarations.Declared declared = Declarations.of(model, inputs, compliance, reads, positions);
        List<CtType<?>> types = declared.types();
        // The generated sources are in the model for resolution only: a reader of call targets must know their members,
        // but not one row is written for them.
        List<CtType<?>> known = knownTypes(model, types);
        LombokOracle.Outcome oracle = LombokOracle.run(root, inputs, lombok, reads, compliance, types, positions,
                failures);
        Map<String, List<Lombok.Item>> synth = Lombok.synthesize(types, positions, failures, oracle.generated());
        TypesWriter.write(types, positions, outDir.resolve("types.ndjson"), failures);
        Walk.Bodies bodies = new Walk.Bodies(types, positions);
        CallIds ids = new CallIds();
        Refs refs = new Refs(ids, failures);
        CallsWriter.Written written = CallsWriter.write(types, known, Lombok.Index.of(synth), bodies, positions, ids,
                refs, outDir.resolve("calls.ndjson"));
        MembersWriter.write(types, synth, bodies, positions, outDir.resolve("members.ndjson"), written.returns(),
                failures);
        FieldsWriter.write(written.fields(), outDir.resolve("fields.ndjson"));
        int libraries = LibraryWriter.write(types, known, outDir.resolve("library.ndjson"));
        int failed = FilesWriter.write(inputs, types, model.packages(),
                FileProblems.of(model, positions, declared.unread()), positions, outDir.resolve("files.ndjson"),
                failures);
        MetaWriter.write(new MetaWriter.Facts(inputs, types, failed, compliance, classpath, generatedDirs,
                model.generatedFiles(), libraries, load.dropped(), unreadable, oracle), failures,
                outDir.resolve("meta.json"));
    }

    /** Counts each input that is not valid UTF-8: Spoon reads it, and the engine reads it, as ISO-8859-1. */
    private static void countNotUtf8(Path root, List<String> inputs, Failures failures) {
        for (String rel : inputs) if (SourceText.notUtf8(root.resolve(rel))) failures.count(Failures.Key.NOT_UTF8);
    }

    /**
     * The project-relative Java files the list names, sorted: neither the model nor the first of two same-named
     * declarations depends on the order the list was written in. A file that cannot be opened is not an input: Spoon
     * would abort the whole model on it, so it is counted under {@code files.unreadable} and has no row.
     */
    private static List<String> inputs(Path root, Path listPath, Failures failures) throws IOException {
        List<String> inputs = new ArrayList<>();
        for (String rel : SourceModel.relativeFiles(root, Files.readAllLines(listPath, StandardCharsets.UTF_8))) {
            if (Files.isReadable(root.resolve(rel))) inputs.add(rel);
            else failures.count(Failures.Key.FILE_UNREADABLE);
        }
        inputs.sort(null);
        return inputs;
    }

    /** The declared types, and the generated types the model holds for resolution. */
    private static List<CtType<?>> knownTypes(SourceModel model, List<CtType<?>> types) {
        List<CtType<?>> known = new ArrayList<>(types);
        for (CtType<?> t : model.allTypes())
            if (model.isGenerated(t) && Declarations.isDeclared(t)) known.add(t);
        return known;
    }
}
