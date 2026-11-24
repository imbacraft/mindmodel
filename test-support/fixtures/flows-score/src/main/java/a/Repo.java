package a;
public interface Repo {
  Order save(Order o);
  Order find(Long id);
}
