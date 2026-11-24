package generic;

public class SecondImpl implements Port {
    @Override
    public void go(Row row) {
        row.setState(null);
    }
}
