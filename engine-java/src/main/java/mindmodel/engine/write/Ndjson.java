package mindmodel.engine.write;

import java.io.IOException;
import java.io.StringWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;

/**
 * One JSON object per line: a section that streams and diffs. A row is written aside and copied to the file only when
 * it is whole, so a row that fails half-way leaves nothing behind for the caller to write its error row after.
 */
public final class Ndjson implements AutoCloseable {

    /** Writes the fields of one row. */
    public interface Body {
        void write(JsonGenerator g) throws IOException;
    }

    private static final JsonFactory JSON = new JsonFactory();

    private final Writer file;
    private boolean first = true;

    public Ndjson(Path path) throws IOException {
        file = Files.newBufferedWriter(path, StandardCharsets.UTF_8);
    }

    /** Writes one row: the object the body writes, on a line of its own. */
    public void row(Body body) throws IOException {
        StringWriter text = new StringWriter();
        try (JsonGenerator g = JSON.createGenerator(text)) {
            g.writeStartObject();
            body.write(g);
            g.writeEndObject();
        }
        // Rows are separated by a newline, never terminated by one: the file ends with its last row's closing brace.
        if (!first) file.write('\n');
        first = false;
        file.write(escapeLoneSurrogates(text.toString()));
    }

    /**
     * UTF-8 cannot hold an unpaired UTF-16 surrogate, and the file's encoder refuses one. A string that carries one (a
     * backslash-u literal of a lone half, or a source text cut between the two halves of a pair) is written as its
     * backslash-u escape, which every JSON reader decodes back to the same char. Pairs are written as they are. Every
     * surrogate sits inside a JSON string, so the escape is valid where it lands.
     */
    static String escapeLoneSurrogates(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                out.append(c).append(text.charAt(++i));
            } else if (Character.isSurrogate(c)) {
                out.append(String.format("\\u%04X", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    @Override
    public void close() throws IOException {
        file.close();
    }
}
