package nested;

public class Outer {
    public class Inner {
        public String hello() { return "hi"; }
    }

    public Runnable anonymous() {
        class Local { int n() { return 1; } }
        return new Runnable() {
            @Override
            public void run() { new Local().n(); }
        };
    }
}
