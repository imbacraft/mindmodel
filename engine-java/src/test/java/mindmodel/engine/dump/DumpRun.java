package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import javax.tools.ToolProvider;

import mindmodel.engine.SourceModel;

/**
 * Dumps a few Java sources through {@link Dump#run}, as the CLI does, and reads the rows back. One checkout can be
 * dumped again into another folder, so a test can compare two dumps of the same bytes on disk.
 */
final class DumpRun {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path dir;
    private final Path root;
    /** The folder the first dump wrote: every section is read from here. */
    final Path out;

    private DumpRun(Path dir, Path root, Path out) {
        this.dir = dir;
        this.root = root;
        this.out = out;
    }

    /** Writes each source at its relative path under {@code dir/src} and dumps them, in map order. */
    static DumpRun of(Path dir, Map<String, String> sources) throws IOException {
        return of(dir, sources, new ArrayList<>(sources.keySet()));
    }

    /** As {@link #of(Path, Map)}, with the file list in the given order. */
    static DumpRun of(Path dir, Map<String, String> sources, List<String> listed) throws IOException {
        return of(dir, sources, listed, SourceModel.compliance());
    }

    /** As {@link #of(Path, Map, List)}, at a Java level other than the default (pattern switches need 21). */
    static DumpRun of(Path dir, Map<String, String> sources, List<String> listed, int compliance) throws IOException {
        return of(dir, sources, listed, compliance, List.of());
    }

    /** As {@link #of(Path, Map, List, int)}, with dependency jars or class folders on the classpath Spoon reads. */
    static DumpRun of(Path dir, Map<String, String> sources, List<String> listed, int compliance,
            List<String> classpath) throws IOException {
        Path root = dir.resolve("src");
        for (var source : sources.entrySet()) {
            Path file = root.resolve(source.getKey());
            Files.createDirectories(file.getParent());
            Files.writeString(file, source.getValue());
        }
        Path out = dump(dir, root, listed, "out", compliance, classpath);
        return new DumpRun(dir, root, out);
    }

    /** Dumps the same checkout again into {@code dir/<outName>}, with the file list in the given order. */
    Path redump(String outName, List<String> listed) throws IOException {
        return dump(dir, root, listed, outName, SourceModel.compliance(), List.of());
    }

    private static Path dump(Path dir, Path root, List<String> listed, String outName, int compliance,
            List<String> classpath) throws IOException {
        Path list = dir.resolve("files-" + outName + ".txt");
        Files.write(list, listed);
        Path out = dir.resolve(outName);
        Dump.run(root, list, out, compliance, classpath, List.of());
        return out;
    }

    /** Every row of one section ({@code types}, {@code calls}, ...), in the order the dump wrote them. */
    List<JsonNode> rows(String section) throws IOException {
        List<JsonNode> rows = new ArrayList<>();
        for (String line : Files.readAllLines(out.resolve(section + ".ndjson")))
            if (!line.isBlank()) rows.add(JSON.readTree(line));
        return rows;
    }

    JsonNode meta() throws IOException {
        return JSON.readTree(out.resolve("meta.json").toFile());
    }

    /** The single row whose {@code field} is {@code value}; fails the test when there is not exactly one. */
    static JsonNode one(List<JsonNode> rows, String field, String value) {
        List<JsonNode> hits = rows.stream().filter(r -> value.equals(r.path(field).asText())).toList();
        if (hits.size() != 1) throw new AssertionError(field + "=" + value + " matched " + hits.size() + " rows");
        return hits.get(0);
    }

    /**
     * Compiles library sources into a class folder, which a dump reads as a classpath entry the way it reads a jar.
     * Keys are each file's path under {@code dir/libsrc}, which is also its package's path.
     */
    static Path compile(Path dir, Map<String, String> sources) throws IOException {
        List<String> files = new ArrayList<>();
        for (var source : sources.entrySet()) {
            Path file = dir.resolve("libsrc").resolve(source.getKey());
            Files.createDirectories(file.getParent());
            Files.writeString(file, source.getValue());
            files.add(file.toString());
        }
        Path classes = dir.resolve("libclasses");
        Files.createDirectories(classes);
        List<String> args = new ArrayList<>(List.of("-d", classes.toString()));
        args.addAll(files);
        int status = ToolProvider.getSystemJavaCompiler().run(null, null, null, args.toArray(new String[0]));
        if (status != 0) throw new AssertionError("the test library does not compile: " + sources.keySet());
        return classes;
    }

    /** 1-based line of the first source line containing {@code needle}. */
    static int lineOf(String source, String needle) {
        String[] lines = source.split("\n", -1);
        for (int i = 0; i < lines.length; i++) if (lines[i].contains(needle)) return i + 1;
        throw new AssertionError("no line contains: " + needle);
    }
}
