package mindmodel.engine.write;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Properties;

/**
 * The dump's contract number, the engine name and the engine version. meta.json and {@code --version} write them, and
 * the version is read from the copy filtered out of the pom, so it is written once, in the pom.
 */
public final class Contract {

    /** The shape of the dump. A consumer refuses any other number. */
    public static final int CONTRACT = 8;
    public static final String ENGINE = "spoon-11.5.0";
    /** The engine's version, as the pom states it. */
    public static final String VERSION = version();

    private Contract() {
    }

    private static String version() {
        String name = "/mindmodel/engine/version.properties";
        try (InputStream in = Contract.class.getResourceAsStream(name)) {
            if (in == null) throw new IllegalStateException(name + " is missing from the engine jar");
            Properties properties = new Properties();
            properties.load(in);
            String version = properties.getProperty("engine.version");
            if (version == null || version.isBlank() || version.contains("${"))
                throw new IllegalStateException(name + " has no filtered engine.version");
            return version.trim();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
