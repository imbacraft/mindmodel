package mindmodel.engine.run;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import spoon.reflect.declaration.CtType;

import mindmodel.engine.model.Declarations;
import mindmodel.engine.model.Duplicates;
import mindmodel.engine.model.Failures;
import mindmodel.engine.model.FileProblems;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.SourceModel;
import mindmodel.engine.model.Walk;
import mindmodel.engine.resolve.CallIds;
import mindmodel.engine.resolve.Lombok;
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
     */
    public static void run(Path given, Path listPath, Path outDir, int compliance, List<String> classpath,
            List<String> generatedDirs) throws IOException {
        // Spoon reports canonical paths (macOS /var is /private/var): every relativised or prefix-checked path below is
        // measured against the canonical root.
        Path root = SourceModel.realPath(given);
        Files.createDirectories(outDir);
        List<String> inputs = inputs(root, listPath);
        SourceModel.Load load = SourceModel.load(root, inputs, compliance, classpath, generatedDirs);
        SourceModel model = load.model();
        // The classpath that model actually read with: a dropped one is dropped for every later model too.
        List<String> reads = load.dropped() == null ? classpath : List.of();
        Positions positions = new Positions(root);
        Failures failures = new Failures();
        Duplicates.count(model, root, compliance, reads, failures);
        Declarations.Declared declared = Declarations.of(model, inputs, compliance, reads, positions);
        List<CtType<?>> types = declared.types();
        // The generated sources are in the model for resolution only: a reader of call targets must know their members,
        // but not one row is written for them.
        List<CtType<?>> known = knownTypes(model, types);
        Map<String, List<Lombok.Item>> synth = Lombok.synthesize(types, positions, failures);
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
                model.generatedFiles(), libraries, load.dropped()), failures, outDir.resolve("meta.json"));
    }

    /**
     * The project-relative Java files the list names, sorted: neither the model nor the first of two same-named
     * declarations depends on the order the list was written in.
     */
    private static List<String> inputs(Path root, Path listPath) throws IOException {
        List<String> inputs = new ArrayList<>(SourceModel.relativeFiles(root,
                Files.readAllLines(listPath, StandardCharsets.UTF_8)));
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
