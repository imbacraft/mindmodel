package mindmodel.engine.run;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.reflect.code.CtInvocation;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.SourceModel;
import mindmodel.engine.resolve.FieldAccess;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.write.CallsWriter;
import mindmodel.engine.write.FieldsWriter;
import mindmodel.engine.write.LibraryWriter;

/**
 * The contract's JSON Schemas (engine-java/contract/) against what the dump writes. Every row of every section, dumped
 * from the on-disk test fixture and from the conventions fixture, must match its schema: the schemas name every key and
 * forbid the rest, so a shape drift fails here. The error rows the writers produce for a site Spoon cannot answer are
 * checked the same way, since no fixture can make Spoon fail.
 */
class ContractSchemaTest {

    /** The schemas, read from the engine's folder (the test's working directory is the engine module). */
    private static final Path CONTRACT = Path.of("contract").toAbsolutePath();
    /** The on-disk fixture the Node side also dumps: a checkout the engine reads with no classpath. */
    private static final Path FIXTURE = Path.of("..", "test", "dump-fixture").toAbsolutePath().normalize();
    private static final JsonSchemaFactory FACTORY = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Each output file, and the schema its rows are checked against. */
    private static final Map<String, String> SCHEMAS = new LinkedHashMap<>();

    static {
        for (String section : List.of("types", "members", "calls", "fields", "files", "library"))
            SCHEMAS.put(section, section + ".schema.json");
        SCHEMAS.put("meta", "meta.schema.json");
    }

    @TempDir
    static Path dir;

    @Test
    void everyRowOfTheOnDiskFixtureMatchesItsSchema() throws Exception {
        Path root = FIXTURE;
        Path list = dir.resolve("fixture-files.txt");
        try (Stream<Path> walk = Files.walk(root.resolve("src"))) {
            List<String> files = walk.filter(p -> p.toString().endsWith(".java"))
                    .map(p -> root.relativize(p).toString().replace('\\', '/')).sorted().toList();
            Files.write(list, files);
        }
        Path out = dir.resolve("fixture-out");
        Dump.run(root, list, out, 17, List.of(), List.of(), null);
        assertNoViolations(out);
    }

    @Test
    void everyRowOfTheConventionsFixtureMatchesItsSchema() throws Exception {
        // The conventions fixture is the one that writes every row kind, library rows included (it has a classpath).
        Path classes = DumpRun.compile(dir.resolve("conventions-lib"),
                Map.of("lib/Holder.java", DumpConventionsTest.LIB));
        // A type argument Spoon cannot name (Missing is never imported): its typeArgs entry is null, and the list keeps
        // the position of every argument. The conventions fixture has no such case of its own.
        Map<String, String> sources = new LinkedHashMap<>(DumpConventionsTest.SOURCES);
        sources.put("demo/Arguments.java", """
                package demo;
                import java.util.List;
                class Arguments {
                    List<Missing> rows;
                    List<String> names() { return rows.stream().map(r -> r.toString()).toList(); }
                }
                """);
        List<String> listed = new ArrayList<>(sources.keySet());
        DumpRun run = DumpRun.of(dir.resolve("conventions"), sources, listed, 21, List.of(classes.toString()));
        assertNoViolations(run.out);
        assertTrue(run.rows("library").size() > 0, "the classpath fixture writes library rows");
    }

    @Test
    void theErrorRowsTheWritersMakeMatchTheirSchemas() throws Exception {
        Path root = dir.resolve("errors").resolve("src");
        // The sources go to disk so Spoon can model them: the helper call the error row describes is read from there.
        DumpRun.of(dir.resolve("errors"), DumpConventionsTest.SOURCES, List.of("demo/Kinds.java"), 21);
        Positions positions = new Positions(root);
        CtInvocation<?> helper =
                DumpConventionsTest.helperCall(SourceModel.build(root, List.of("demo/Kinds.java"), 21));
        assertTrue(helper != null, "the fixture calls helper()");
        assertValid("calls", DumpConventionsTest.writeRow(g -> CallsWriter.errorRow(g, "demo.Box#wire(List<String>)",
                "demo.Box#wire(List<String>)@1:1", helper, positions.of(helper), new IllegalStateException("boom"),
                new Failures())));
        assertValid("fields", DumpConventionsTest.writeRow(g -> FieldsWriter.errorRow(g,
                new FieldAccess.Row("demo.Box#wire(List<String>)", "demo.Box#label", false, "write",
                        positions.of(helper), Refs.Ref.plain("label", "field", null), List.of()),
                new IllegalStateException("boom"))));
        assertValid("library", DumpConventionsTest.writeRow(g ->
                LibraryWriter.unreadable(g, "lib.Broken", new IllegalStateException("boom"))));
    }

    @Test
    void theSchemasRefuseAnUnknownKeyAndAMissingOne() throws Exception {
        Path out = dir.resolve("shape-out");
        Dump.run(FIXTURE, fixtureList(), out, 17, List.of(), List.of(), null);
        JsonNode row = JSON.readTree(Files.readAllLines(out.resolve("types.ndjson")).get(0));

        ObjectNode unknown = ((ObjectNode) row.deepCopy()).put("drift", true);
        assertFalse(violations("types", unknown).isEmpty(), "an unknown key is a violation");

        ObjectNode missing = ((ObjectNode) row.deepCopy());
        missing.remove("pos");
        assertFalse(violations("types", missing).isEmpty(), "a missing key is a violation");
    }

    /** The fixture's Java files, relative to the fixture root, sorted. */
    private static Path fixtureList() throws IOException {
        Path list = dir.resolve("shape-files.txt");
        try (Stream<Path> walk = Files.walk(FIXTURE.resolve("src"))) {
            List<String> files = walk.filter(p -> p.toString().endsWith(".java"))
                    .map(p -> FIXTURE.relativize(p).toString().replace('\\', '/')).sorted().toList();
            Files.write(list, files);
        }
        return list;
    }

    /** Every row of every section of a dump, against its schema, with the first failures named. */
    private static void assertNoViolations(Path out) throws IOException {
        List<String> problems = new ArrayList<>();
        for (String section : SCHEMAS.keySet()) {
            if ("meta".equals(section)) {
                for (String p : violations("meta", JSON.readTree(Files.readString(out.resolve("meta.json")))))
                    problems.add("meta.json: " + p);
                continue;
            }
            List<String> lines = Files.readAllLines(out.resolve(section + ".ndjson"));
            for (int i = 0; i < lines.size(); i++) {
                if (lines.get(i).isBlank()) continue;
                for (String p : violations(section, JSON.readTree(lines.get(i))))
                    problems.add(section + ".ndjson:" + (i + 1) + ": " + p);
            }
        }
        assertEquals(List.of(), problems.subList(0, Math.min(20, problems.size())),
                problems.size() + " rows break the contract's schemas");
    }

    private static void assertValid(String section, JsonNode row) throws IOException {
        List<String> problems = violations(section, row);
        assertTrue(problems.isEmpty(), section + " row breaks its schema: " + problems);
    }

    /** The messages a row breaks its section's schema with, empty when it matches. */
    private static List<String> violations(String section, JsonNode row) throws IOException {
        JsonSchema schema = FACTORY.getSchema(CONTRACT.resolve(SCHEMAS.get(section)).toUri());
        List<String> out = new ArrayList<>();
        Set<ValidationMessage> messages = schema.validate(row);
        for (ValidationMessage m : messages) out.add(m.getMessage());
        return out;
    }
}
