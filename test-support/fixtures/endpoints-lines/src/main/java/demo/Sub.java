package demo;

import org.springframework.web.bind.annotation.GetMapping;

public class Sub extends Base {

  @Override
  public String list() {
    return "";
  }

  @GetMapping("/save2")
  public String save() {
    return "";
  }
}
