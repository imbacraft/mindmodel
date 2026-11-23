package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.io.SerializedString;

/** One JSON object per line: a section that streams and diffs. */
public final class Ndjson implements AutoCloseable {

    /** Writes the fields of one row. */
    public interface Body {
        void write(JsonGenerator g) throws IOException;
    }

    private final JsonGenerator g;

    public Ndjson(Path file) throws IOException {
        g = new JsonFactory().createGenerator(file.toFile(), JsonEncoding.UTF8);
        g.setRootValueSeparator(new SerializedString("\n"));
    }

    public void row(Body body) throws IOException {
        g.writeStartObject();
        body.write(g);
        g.writeEndObject();
    }

    public static void pos(JsonGenerator g, Positions.Pos p) throws IOException {
        if (p == null) {
            g.writeNullField("pos");
            return;
        }
        g.writeObjectFieldStart("pos");
        g.writeStringField("file", p.file());
        g.writeNumberField("line", p.line());
        g.writeNumberField("col", p.col());
        g.writeNumberField("endLine", p.endLine());
        g.writeNumberField("endCol", p.endCol());
        g.writeEndObject();
    }

    @Override
    public void close() throws IOException {
        g.close();
    }
}
