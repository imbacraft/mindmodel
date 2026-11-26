package mindmodel.engine.write;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.model.Classpath;
import mindmodel.engine.model.Failures;
import mindmodel.engine.resolve.LombokOracle;

/** meta.json: the contract, the classpath digest, what was counted, and what the run could not read. */
public final class MetaWriter {

    /** What the run read, for the meta.json fields that describe the inputs rather than the failures. */
    public record Facts(List<String> inputs, List<CtType<?>> types, int failedFiles, int compliance,
                        List<String> classpath, List<String> generatedDirs, int generatedFiles, int libraries,
                        String dropped, List<Classpath.Dropped> unreadable, LombokOracle.Outcome lombok) {
    }

    private MetaWriter() {
    }

    public static void write(Facts facts, Failures failures, Path out) throws IOException {
        int fields = 0;
        int methods = 0;
        for (CtType<?> t : facts.types()) {
            fields += t.getFields().size();
            methods += t.getMethods().size();
        }
        try (JsonGenerator g = new JsonFactory().createGenerator(out.toFile(), JsonEncoding.UTF8)) {
            g.useDefaultPrettyPrinter();
            g.writeStartObject();
            g.writeNumberField("contract", Contract.CONTRACT);
            g.writeStringField("engine", Contract.ENGINE);
            g.writeStringField("engineVersion", Contract.VERSION);
            g.writeNumberField("compliance", facts.compliance());
            // No timestamp, and no root: a dump of the same inputs is byte-identical wherever the checkout lives.
            g.writeObjectFieldStart("classpath");
            g.writeNumberField("entries", facts.classpath().size());
            g.writeStringField("sha256", jarDigest(facts.classpath()));
            g.writeNumberField("generatedDirs", facts.generatedDirs().size());
            // Generated files in the model: read so a project call into one resolves, written as nothing.
            g.writeNumberField("generatedFiles", facts.generatedFiles());
            g.writeNumberField("libraryTypes", facts.libraries());
            if (facts.dropped() != null) g.writeStringField("dropped", Failures.scrub(facts.dropped()));
            if (!facts.unreadable().isEmpty()) {
                g.writeArrayFieldStart("unreadable");
                for (Classpath.Dropped entry : facts.unreadable()) {
                    g.writeStartObject();
                    g.writeStringField("name", entry.name());
                    g.writeStringField("reason", entry.reason());
                    g.writeEndObject();
                }
                g.writeEndArray();
            }
            g.writeEndObject();
            // Which answer the Lombok members came from, and why it was not delombok when it was not.
            g.writeObjectFieldStart("lombok");
            g.writeStringField("mode", facts.lombok().mode());
            g.writeNumberField("files", facts.lombok().files());
            if (facts.lombok().reason() != null) g.writeStringField("reason", facts.lombok().reason());
            g.writeEndObject();
            g.writeObjectFieldStart("counts");
            g.writeNumberField("files", facts.inputs().size());
            g.writeNumberField("types", facts.types().size());
            g.writeNumberField("fields", fields);
            g.writeNumberField("methods", methods);
            g.writeNumberField("failedFiles", facts.failedFiles());
            // What the engine answered empty rather than failing, by reason: a run says what it could not read.
            for (var count : failures.counts().entrySet()) g.writeNumberField(count.getKey(), count.getValue());
            g.writeEndObject();
            g.writeEndObject();
        }
    }

    /**
     * A digest of the classpath: each entry's file name and size, in order, so a run says which jars it read and a
     * changed jar set changes the digest. The name, not the path: the directory is the host, and the same jars must
     * give the same digest wherever they sit. The jars themselves are never read.
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
            long size = Files.isRegularFile(p) ? Files.size(p) : 0;
            String name = p.getFileName() == null ? "" : p.getFileName().toString();
            md.update((name + ":" + size + "\n").getBytes(StandardCharsets.UTF_8));
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
