package contract;

import java.util.function.Consumer;

public class Sink {
    public void take(Object value) { }

    public String name() { return "sink"; }

    public void each(Consumer<Object> action) { }
}
