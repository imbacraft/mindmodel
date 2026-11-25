package mindmodel.engine.write;

/** The dump's contract number and engine name: meta.json and the {@code version} command both write them. */
public final class Contract {

    /** The shape of the dump. Node refuses any other number (`dump.mjs` `open()`). */
    public static final int CONTRACT = 8;
    public static final String ENGINE = "spoon-11.5.0";

    private Contract() {
    }
}
